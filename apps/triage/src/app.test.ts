import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@cc-setup-agent/core';
import {
  catalogItems,
  claudeCodeChanges,
  eq,
  insertCandidate,
  scorecards,
  statusEvents,
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
