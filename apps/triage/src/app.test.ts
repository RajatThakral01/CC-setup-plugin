import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@cc-setup-agent/core';
import {
  catalogItems,
  claudeCodeChanges,
  eq,
  evalRuns,
  insertCandidate,
  policyDecisions,
  scorecards,
  statusEvents,
  transitionStatus,
} from '@cc-setup-agent/db';
import { createTestDatabase, type TestDatabase } from '@cc-setup-agent/db/testing';
import { createApp } from './app.js';
import { csrfToken, SESSION_COOKIE, signSession } from './auth.js';

const TOKEN = 'test-admin-token-0123456789';
let t: TestDatabase;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await createTestDatabase();
  app = createApp({ db: t.db, adminToken: TOKEN, logger: createLogger({ level: 'silent' }) });
});
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(async () => {
  await t.db.delete(policyDecisions);
  await t.db.delete(evalRuns);
  await t.db.delete(scorecards);
  await t.db.delete(statusEvents);
  await t.db.delete(catalogItems);
  await t.db.delete(claudeCodeChanges);
});

const cookie = (name = 'owner') => `${SESSION_COOKIE}=${signSession(TOKEN, name)}`;
const get = (path: string, withCookie = true) =>
  app.request(path, { headers: withCookie ? { cookie: cookie() } : {} });
function post(
  path: string,
  fields: Record<string, string>,
  options: { cookie?: string | null; csrf?: string | null } = {},
) {
  const body = new URLSearchParams({
    ...fields,
    ...(options.csrf === null ? {} : { csrf: options.csrf ?? csrfToken(TOKEN, 'owner') }),
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (options.cookie !== null) headers['cookie'] = options.cookie ?? cookie();
  return app.request(path, { method: 'POST', body, headers });
}

async function item(id: string, extra: Partial<typeof catalogItems.$inferInsert> = {}) {
  await insertCandidate(
    t.db,
    {
      id,
      name: id,
      sourceUrl: `https://github.com/example-org/${id}`,
      kind: 'mcp_server',
      category: 'browser_testing',
      ...extra,
    },
    'system',
    'fixture',
  );
}
async function scorecard(itemId: string, gate3: 'pass' | 'fail') {
  const checkedAt = '2026-10-19T00:00:00.000Z';
  await t.db.insert(scorecards).values({
    itemId,
    version: '1.0.0',
    confidence: gate3 === 'pass' ? 'high' : 'low',
    gateResults: {
      gate0_hygiene: { result: 'pass', evidence: [], checkedAt },
      gate3_security: {
        result: gate3,
        evidence: [],
        checkedAt,
        ...(gate3 === 'fail' ? { notes: 'flagged' } : {}),
      },
    },
    securityFindings:
      gate3 === 'fail'
        ? [
            {
              severity: 'high',
              description: 'References a sensitive file in tool.description',
              evidence: '~/.ssh',
            },
          ]
        : [],
  });
}

describe('authentication', () => {
  it('redirects pages to sign-in and refuses posts without a session', async () => {
    expect((await get('/', false)).status).toBe(303);
    expect((await get('/', false)).headers.get('location')).toBe('/login');
    expect(
      (await post('/items/x/status', { to: 'watchlist', reason: 'abc' }, { cookie: null })).status,
    ).toBe(401);
  });

  it('rejects forged or tampered sessions', async () => {
    const forged = `${SESSION_COOKIE}=owner.${'A'.repeat(43)}`;
    expect((await app.request('/', { headers: { cookie: forged } })).status).toBe(303);
    const tampered = `${SESSION_COOKIE}=${signSession(TOKEN, 'owner').replace('owner', 'admin')}`;
    expect((await app.request('/', { headers: { cookie: tampered } })).status).toBe(303);
  });

  it('signs in with the right token and sets a strict http-only cookie', async () => {
    const bad = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ name: 'owner', token: 'wrong' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(bad.status).toBe(401);
    const ok = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ name: 'owner', token: TOKEN }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(ok.status).toBe(303);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const badName = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ name: 'bad name!', token: TOKEN }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(badName.status).toBe(400);
  });

  it('requires the CSRF token on state changes', async () => {
    await item('example-a');
    expect(
      (await post('/items/example-a/status', { to: 'watchlist', reason: 'stale' }, { csrf: null }))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          '/items/example-a/status',
          { to: 'watchlist', reason: 'stale' },
          { csrf: 'nope' },
        )
      ).status,
    ).toBe(403);
  });

  it('refuses a weak admin token at startup', () => {
    expect(() =>
      createApp({ db: t.db, adminToken: 'short', logger: createLogger({ level: 'silent' }) }),
    ).toThrow(/at least 16/);
  });

  it('sends security headers', async () => {
    const res = await get('/login', false);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('queue', () => {
  it('lists candidates, hides out-of-scope items by default and shows them on request', async () => {
    await item('example-in');
    await item('example-out', { outOfScope: ['nextjs'] });
    const html = await (await get('/')).text();
    expect(html).toContain('example-in');
    expect(html).not.toContain('href="/items/example-out"');
    expect(html).toContain('1 out-of-scope item(s) hidden');
    const out = await (await get('/?scope=out')).text();
    expect(out).toContain('href="/items/example-out"');
    expect(out).not.toContain('href="/items/example-in"');
    expect(await (await get('/?scope=all')).text()).toContain('example-out');
  });

  it('marks security-flagged items in the list', async () => {
    await item('example-flagged');
    await scorecard('example-flagged', 'fail');
    expect(await (await get('/')).text()).toContain('security flag');
  });

  it('escapes third-party text and refuses non-https links', async () => {
    await item('example-xss', {
      name: '<script>alert(1)</script>',
      description: '<img src=x onerror=alert(1)>',
    });
    const list = await (await get('/')).text();
    expect(list).not.toContain('<script>alert(1)</script>');
    expect(list).toContain('&lt;script&gt;');
    await t.db
      .update(catalogItems)
      .set({ sourceUrl: 'javascript:alert(1)' })
      .where(eq(catalogItems.id, 'example-xss'));
    const detail = await (await get('/items/example-xss')).text();
    expect(detail).not.toContain('href="javascript:');
    expect(detail).not.toContain('<img src=x');
  });
});

describe('status changes', () => {
  it('approves to recommended_provisional with a reason and shows it in the audit log', async () => {
    await item('example-good');
    await scorecard('example-good', 'pass');
    const res = await post('/items/example-good/status', {
      to: 'recommended_provisional',
      reason: 'gates pass, official vendor',
    });
    expect(res.status).toBe(303);
    const [row] = await t.db.select().from(catalogItems).where(eq(catalogItems.id, 'example-good'));
    expect(row?.status).toBe('recommended_provisional');
    const events = await t.db
      .select()
      .from(statusEvents)
      .where(eq(statusEvents.itemId, 'example-good'));
    expect(events.at(-1)).toMatchObject({
      actor: 'human:owner',
      toStatus: 'recommended_provisional',
      reason: 'gates pass, official vendor',
    });
    const page = await (await get('/items/example-good?saved=recommended_provisional')).text();
    expect(page).toContain('human:owner');
    expect(page).toContain('Status changed to recommended_provisional');
  });

  it('requires a reason', async () => {
    await item('example-b');
    const res = await post('/items/example-b/status', { to: 'watchlist', reason: ' ' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('a reason is required');
  });

  it('shows a flagged item prominently and requires a written override to approve it', async () => {
    await item('example-flagged');
    await scorecard('example-flagged', 'fail');
    const page = await (await get('/items/example-flagged')).text();
    expect(page).toContain('class="flag"');
    expect(page).toContain('References a sensitive file');
    expect(page).toContain('Security override note');

    const refused = await post('/items/example-flagged/status', {
      to: 'recommended_provisional',
      reason: 'want it',
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('written override');
    const approved = await post('/items/example-flagged/status', {
      to: 'recommended_provisional',
      reason: 'reviewed',
      override: 'path appears in docs, not an instruction',
    });
    expect(approved.status).toBe(303);
    const events = await t.db
      .select()
      .from(statusEvents)
      .where(eq(statusEvents.itemId, 'example-flagged'));
    expect(events.at(-1)?.reason).toBe(
      'reviewed | override: path appears in docs, not an instruction',
    );
  });

  it('reports invalid transitions and unknown items', async () => {
    await item('example-c');
    expect(
      (await post('/items/example-c/status', { to: 'deprecated', reason: 'old' })).status,
    ).toBe(409);
    expect(
      (await post('/items/example-c/status', { to: 'not-a-status', reason: 'old' })).status,
    ).toBe(400);
    expect(
      (await post('/items/example-missing/status', { to: 'watchlist', reason: 'old' })).status,
    ).toBe(404);
    expect((await get('/items/example-missing')).status).toBe(404);
  });

  it('toggles Next.js scope', async () => {
    await item('example-d');
    await post('/items/example-d/scope', { out: '1' });
    expect(
      (await t.db.select().from(catalogItems).where(eq(catalogItems.id, 'example-d')))[0]
        ?.outOfScope,
    ).toEqual(['nextjs']);
    await post('/items/example-d/scope', { out: '0' });
    expect(
      (await t.db.select().from(catalogItems).where(eq(catalogItems.id, 'example-d')))[0]
        ?.outOfScope,
    ).toEqual([]);
  });
});

describe('eval results', () => {
  it('shows the eval summary against the baseline and each run', async () => {
    await item('example-candidate');
    await t.db.insert(scorecards).values({
      itemId: 'example-candidate',
      version: '1.0.0',
      evalSummary: {
        taskSetVersion: 'browser_testing-v1-abcd1234',
        model: 'claude-sonnet-5-5',
        claudeCodeVersion: '2.1.303',
        baselineItemId: 'example-incumbent',
        runs: 5,
        successRate: 0.8,
        baselineSuccessRate: 0.4,
        meanTokens: 12345,
        meanCostUsd: 0.2345,
        meanWallSeconds: 95,
        contextOverheadTokens: 1200,
        verdict: 'better',
      },
    });
    await t.db.insert(evalRuns).values({
      runId: '20261019-abcdef0123',
      itemId: 'example-candidate',
      itemVersion: '1.0.0',
      taskId: 'counter-increment',
      taskSetVersion: 'browser_testing-v1-abcd1234',
      model: 'claude-haiku-5-5',
      claudeCodeVersion: '2.1.303',
      withTool: true,
      success: true,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.0123,
      wallSeconds: 61,
      stage: 'pilot',
      logsRef: 'local:20261019-abcdef0123',
    });
    // Whitespace-insensitive: the template's text wraps across lines.
    const page = (await (await get('/items/example-candidate')).text()).replace(/\s+/g, ' ');
    expect(page).toMatch(/>\s?better\s?<\/span/);
    expect(page).toContain('success 80%');
    expect(page).toContain('example-incumbent');
    expect(page).toContain('counter-increment');
    expect(page).toContain('USD 0.0123');
    expect(page).toContain('local:20261019-abcdef0123');
  });

  it('says when an item has no eval results', async () => {
    await item('example-plain');
    const page = await (await get('/items/example-plain')).text();
    expect(page).toContain('No eval summary yet.');
    expect(page).toContain('No eval runs yet.');
  });
});

describe('Claude Code changes page', () => {
  it('lists change notes and filters by flag', async () => {
    await t.db.insert(claudeCodeChanges).values([
      {
        source: 'claude_code_changelog',
        externalId: '9.9.3',
        version: '9.9.3',
        title: 'Claude Code 9.9.3',
        body: '- MCP fix',
        flags: ['mcp'],
      },
      {
        source: 'claude_code_changelog',
        externalId: '9.9.2',
        version: '9.9.2',
        title: 'Claude Code 9.9.2',
        body: '- Hooks',
        flags: ['hooks'],
      },
    ]);
    const all = await (await get('/changes')).text();
    expect(all).toContain('Claude Code 9.9.3');
    expect(all).toContain('Claude Code 9.9.2');
    const mcp = await (await get('/changes?flag=mcp')).text();
    expect(mcp).toContain('Claude Code 9.9.3');
    expect(mcp).not.toContain('Claude Code 9.9.2');
  });
});

describe('kind and category', () => {
  const review = {
    previousKind: 'plugin',
    previousCategory: 'code_review',
    promptVersion: 'classify-v3',
    changedAt: '2026-10-19T00:00:00.000Z',
  };

  it('shows kind and category prominently, with the reclassification as information only', async () => {
    await item('example-chat', { kind: 'plugin', category: 'git_github' });
    await t.db
      .update(catalogItems)
      .set({ classificationReview: review })
      .where(eq(catalogItems.id, 'example-chat'));
    const page = await (await get('/items/example-chat')).text();
    expect(page).toMatch(/<span class="cls ">plugin<\/span>/);
    expect(page).toMatch(/<span class="cls ">git_github<\/span>/);
    expect(page).toContain('Reclassified (classify-v3):</strong> was');
    expect(page).toContain('action="/items/example-chat/classification"');
    const queue = await (await get('/?status=all')).text();
    expect(queue).toContain('reclassified');
    // No review is required any more (M8.3): the page says so.
    expect(page).toContain('nothing is waiting for you');
    expect(queue).not.toContain('changed: review');
  });

  it('lets the owner set kind and category, marks them owner-set and audits it', async () => {
    await item('example-chat', { kind: 'plugin', category: 'git_github' });
    await t.db
      .update(catalogItems)
      .set({ classificationReview: review })
      .where(eq(catalogItems.id, 'example-chat'));
    const res = await post('/items/example-chat/classification', {
      kind: 'plugin',
      category: 'none',
      technologies: 'Discord, ',
      reason: 'Discord bridge: no category fits',
    });
    expect(res.status).toBe(303);
    const [row] = await t.db.select().from(catalogItems).where(eq(catalogItems.id, 'example-chat'));
    expect(row).toMatchObject({
      category: null,
      categorySetBy: 'human:owner',
      kindSetBy: 'human:owner',
      technologies: ['discord'],
      technologiesSetBy: 'human:owner',
      classificationReview: null,
    });
    const page = await (await get('/items/example-chat?saved=classification')).text();
    expect(page).toContain('Kind, category and technologies saved as owner-set.');
    expect(page).toContain('value="discord"');
    expect(page).toContain('category git_github → none');
  });

  it('refuses an edit without a reason or with an unknown category', async () => {
    await item('example-x');
    expect(
      (
        await post('/items/example-x/classification', {
          kind: 'skill',
          category: 'docs',
          reason: '',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('/items/example-x/classification', {
          kind: 'skill',
          category: 'chat',
          reason: 'valid reason',
        })
      ).status,
    ).toBe(400);
  });

  it('keeps the reclassified-items filter as an optional view', async () => {
    await item('example-a');
    await item('example-b');
    await t.db
      .update(catalogItems)
      .set({ classificationReview: review })
      .where(eq(catalogItems.id, 'example-a'));
    const text = await (await get('/?status=all&review=1')).text();
    expect(text).toContain('/items/example-a');
    expect(text).not.toContain('/items/example-b');
    expect(text).toMatch(/classification changed \(1, optional view\)/);
  });
});

describe('approval policy and owner veto (PRD FR-P8, FR-P9)', () => {
  it('shows the policy decision with every criterion and both opinions', async () => {
    await item('example-a');
    await t.db.insert(policyDecisions).values({
      itemId: 'example-a',
      policyVersion: 'policy-v1',
      action: 'hold',
      fromStatus: 'candidate',
      tier: 'community',
      reason: 'not approved',
      criteria: [
        { id: 'gates_pass', ok: true, detail: 'gates 0, 1, 2, 3 pass' },
        { id: 'eval_beats_incumbent', ok: false, detail: 'no eval yet' },
      ],
      applied: false,
    });
    const page = await (await get('/items/example-a')).text();
    expect(page).toContain('Approval policy');
    expect(page).toContain('eval_beats_incumbent: no eval yet');
    expect(page).toContain('community tier');
    expect(page).toContain('no second opinion yet');
    expect(page).toContain('action="/items/example-a/veto"');
  });

  it('vetoes in one click: demotes, locks and audits; and the veto can be lifted', async () => {
    await item('example-a');
    await scorecard('example-a', 'pass');
    await t.db
      .update(catalogItems)
      .set({ status: 'recommended_provisional' })
      .where(eq(catalogItems.id, 'example-a'));
    expect((await post('/items/example-a/veto', { reason: '' })).status).toBe(400);
    const res = await post('/items/example-a/veto', { reason: 'misleading README' });
    expect(res.status).toBe(303);
    const [row] = await t.db.select().from(catalogItems).where(eq(catalogItems.id, 'example-a'));
    expect(row?.status).toBe('candidate');
    expect(row?.policyVeto).toMatchObject({ by: 'human:owner', reason: 'misleading README' });
    const page = await (await get('/items/example-a?saved=veto')).text();
    expect(page).toContain('Vetoed: locked out of auto-approval.');
    expect(page).toContain('action="/items/example-a/unveto"');
    expect((await post('/items/example-a/unveto', { reason: 'fixed upstream' })).status).toBe(303);
    const [after] = await t.db.select().from(catalogItems).where(eq(catalogItems.id, 'example-a'));
    expect(after?.policyVeto).toBeNull();
    // CSRF still applies.
    expect((await post('/items/example-a/veto', { reason: 'x y z' }, { csrf: 'bad' })).status).toBe(
      403,
    );
  });

  it('shows the weekly digest with what the policy did and why', async () => {
    await item('example-a');
    await scorecard('example-a', 'pass');
    await transitionStatus(
      t.db,
      'example-a',
      'recommended_provisional',
      'policy:policy-v1',
      'official-vendor tier, all criteria hold',
    );
    const page = await (await get('/digest')).text();
    expect(page).toContain('Catalog digest, week of');
    expect(page).toContain('/items/example-a');
    expect(page).toContain('official-vendor tier, all criteria hold');
    expect(page).toContain('Nothing here needs action');
    expect((await get('/digest', false)).status).toBe(303);
  });
});
