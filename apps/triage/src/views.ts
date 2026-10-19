import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import {
  ALLOWED_TRANSITIONS,
  CATEGORIES,
  KINDS,
  STATUSES,
  type GateResult,
  type Status,
} from '@cc-setup-agent/shared';
import type { claudeCodeChanges } from '@cc-setup-agent/db';
import {
  MVP_STACK,
  securityFlagged,
  type ItemDetail,
  type QueueEntry,
  type QueueFilter,
} from './queries.js';

type View = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Links built from third-party data: only https URLs are rendered as links. */
export const safeHref = (url: string): string => (/^https:\/\//i.test(url) ? url : '#');

const STYLE = `
:root { --fg:#1d1d1f; --muted:#6e6e73; --bg:#fff; --line:#e5e5ea; --pass:#1a7f37; --soft:#9a6700; --fail:#cf222e; --na:#6e7781; --accent:#0969da; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header { display:flex; gap:16px; align-items:center; padding:10px 20px; border-bottom:1px solid var(--line); }
header a { color: var(--fg); text-decoration:none; font-weight:600; }
header .who { margin-left:auto; color: var(--muted); }
main { padding: 16px 20px; max-width: 1200px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align: top; }
th { font-weight:600; color: var(--muted); font-size: 12px; }
a { color: var(--accent); }
.badge { display:inline-block; padding:1px 6px; border-radius:10px; font-size:12px; border:1px solid currentColor; }
.pass { color: var(--pass); } .soft_fail { color: var(--soft); } .fail { color: var(--fail); } .not_run { color: var(--na); }
.flag { background:#fff0f0; border:2px solid var(--fail); padding:10px 14px; border-radius:6px; margin: 12px 0; }
.flag h3 { margin: 0 0 6px; color: var(--fail); }
.notice { background:#f0f6ff; border:1px solid var(--accent); padding:8px 12px; border-radius:6px; margin:12px 0; }
.error { background:#fff0f0; border:1px solid var(--fail); padding:8px 12px; border-radius:6px; margin:12px 0; }
.muted { color: var(--muted); }
.cls { font-weight:600; font-size:13px; padding:2px 8px; border-radius:4px; background:#eef4ff; color:#0b3d91; border:1px solid #c7d7f5; display:inline-block; margin:1px 0; }
.cls.none { background:#f6f6f6; color:var(--muted); border-color:var(--line); }
.review { background:#fff8e6; border:2px solid var(--soft); padding:10px 14px; border-radius:6px; margin:12px 0; }
.classification { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:15px; margin:8px 0 4px; }
form.filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; align-items:center; }
textarea { width:100%; min-height:60px; font: inherit; }
label { display:block; margin-top:8px; font-weight:600; }
dl { display:grid; grid-template-columns: 180px 1fr; gap:4px 12px; }
dt { color: var(--muted); }
section { margin-top: 20px; }
pre { white-space: pre-wrap; background:#f6f8fa; padding:8px; border-radius:4px; }
`;

export function layout(title: string, body: View, reviewer?: string, csrf?: string): View {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Triage</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <header>
          <a href="/">Candidate queue</a>
          <a href="/changes">Claude Code changes</a>
          ${
            reviewer
              ? html`<span class="who"
                  >Signed in as ${reviewer}
                  <form method="post" action="/logout" style="display:inline">
                    <input type="hidden" name="csrf" value="${csrf ?? ''}" /><button>
                      Sign out
                    </button>
                  </form></span
                >`
              : ''
          }
        </header>
        <main>${body}</main>
      </body>
    </html>`;
}

const gateBadge = (label: string, g: GateResult | undefined) =>
  html`<span class="badge ${g?.result ?? 'not_run'}" title="${g?.notes ?? ''}"
    >${label} ${g?.result ?? '–'}</span
  >`;

export function loginPage(error?: string): View {
  return layout(
    'Sign in',
    html`<h1>Sign in</h1>
      ${error ? html`<div class="error">${error}</div>` : ''}
      <form method="post" action="/login">
        <label
          >Your name (recorded in the audit log)
          <input name="name" required pattern="[A-Za-z0-9._@-]{1,64}"
        /></label>
        <label>Admin token <input name="token" type="password" required /></label>
        <p><button>Sign in</button></p>
      </form>`,
  );
}

export function queuePage(
  entries: QueueEntry[],
  filter: QueueFilter,
  counts: { in: number; out: number },
  reviewer: string,
  csrf: string,
  needingReview = 0,
): View {
  const opt = (value: string, current: string | undefined, label = value) =>
    html`<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
  return layout(
    'Candidate queue',
    html`<h1>Candidate queue</h1>
      <form class="filters" method="get" action="/">
        <select name="status">
          ${opt('all', filter.status, 'all statuses')} ${STATUSES.map((s) => opt(s, filter.status))}
        </select>
        <select name="scope">
          ${opt('in', filter.scope, `in scope for Next.js (${counts.in})`)}
          ${opt('out', filter.scope, `out of scope (${counts.out})`)}
          ${opt('all', filter.scope, 'all')}
        </select>
        <select name="category">
          ${opt('', filter.category ?? '', 'all categories')}
          ${CATEGORIES.map((c) => opt(c, filter.category))}
        </select>
        <input name="q" placeholder="search id or name" value="${filter.q ?? ''}" />
        <label style="display:inline;font-weight:400"
          ><input type="checkbox" name="review" value="1" ${filter.review ? 'checked' : ''} /> needs
          classification review (${needingReview})</label
        >
        <button>Filter</button>
        ${
          filter.scope === 'in' && counts.out > 0
            ? html`<span class="muted">${counts.out} out-of-scope item(s) hidden.</span>`
            : ''
        }
      </form>
      <table>
        <thead>
          <tr>
            <th>Priority</th>
            <th>Item</th>
            <th>Kind / category</th>
            <th>Provenance</th>
            <th>Confidence</th>
            <th>Gates</th>
            <th>Stars</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(
            (e) =>
              html`<tr>
                <td>${e.priority}</td>
                <td>
                  <a href="/items/${e.item.id}">${e.item.name}</a>
                  ${e.securityFlagged ? html` <span class="badge fail">security flag</span>` : ''}
                  ${e.item.outOfScope.includes(MVP_STACK) ? html` <span class="badge not_run">out of scope</span>` : ''}
                  <div class="muted">${e.item.id}</div>
                </td>
                <td>
                  <span class="cls ${e.item.kind ? '' : 'none'}">${e.item.kind ?? 'no kind'}</span>
                  <span class="cls ${e.item.category ? '' : 'none'}"
                    >${e.item.category ?? 'no category'}</span
                  >
                  ${e.item.classificationReview ? html`<span class="badge soft_fail">changed: review</span>` : ''}
                  ${e.item.categorySetBy ? html`<span class="badge pass">owner-set</span>` : ''}
                </td>
                <td>${e.item.provenance ?? '?'}</td>
                <td>${e.scorecard?.confidence ?? 'not gated'}</td>
                <td>
                  ${gateBadge('G0', e.scorecard?.gateResults.gate0_hygiene)}
                  ${gateBadge('G1', e.scorecard?.gateResults.gate1_provenance)}
                  ${gateBadge('G2', e.scorecard?.gateResults.gate2_health)}
                  ${gateBadge('G3', e.scorecard?.gateResults.gate3_security)}
                </td>
                <td>${e.stars ?? '–'}</td>
                <td>${e.item.status}</td>
              </tr>`,
          )}
        </tbody>
      </table>
      ${entries.length === 0 ? html`<p class="muted">Nothing matches.</p>` : ''}`,
    reviewer,
    csrf,
  );
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Eval summary (from any scorecard version) plus the item's recent eval runs (plan M9). */
function evalSection(d: ItemDetail) {
  const withSummary = d.scorecards.find((c) => c.evalSummary);
  const s = withSummary?.evalSummary;
  const summary = s
    ? html`<p>
        <span
          class="badge ${s.verdict === 'better' ? 'pass' : s.verdict === 'worse' ? 'fail' : 'soft_fail'}"
          >${s.verdict}</span
        >
        version ${withSummary.version} · ${s.model} · ${s.runs} run(s) · success
        ${pct(s.successRate)} vs baseline
        ${s.baselineSuccessRate === null ? 'n/a' : pct(s.baselineSuccessRate)}
        (${s.baselineItemId ?? 'no tool'}) · mean ${Math.round(s.meanTokens)} tokens, USD
        ${s.meanCostUsd.toFixed(4)}, ${Math.round(s.meanWallSeconds)} s · task set
        ${s.taskSetVersion} · Claude Code ${s.claudeCodeVersion}
      </p>`
    : html`<p class="muted">No eval summary yet.</p>`;
  if (d.evalRuns.length === 0)
    return html`${summary}
      <p class="muted">No eval runs yet.</p>`;
  return html`${summary}
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Stage</th>
          <th>Task</th>
          <th>Model</th>
          <th>Result</th>
          <th>Tokens</th>
          <th>Cost</th>
          <th>Time</th>
          <th>Errors</th>
          <th>Logs</th>
        </tr>
      </thead>
      <tbody>
        ${d.evalRuns.map(
          (r) =>
            html`<tr>
              <td>${r.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td>${r.stage}</td>
              <td>${r.taskId}</td>
              <td>${r.model}</td>
              <td>
                <span class="badge ${r.success ? 'pass' : 'fail'}"
                  >${r.success ? 'pass' : 'fail'}</span
                >
              </td>
              <td>${r.inputTokens + r.outputTokens}</td>
              <td>USD ${r.costUsd.toFixed(4)}</td>
              <td>${Math.round(r.wallSeconds)} s</td>
              <td>${r.errors}</td>
              <td>${r.logsRef ?? ''}</td>
            </tr>`,
        )}
      </tbody>
    </table>`;
}

/**
 * Kind and category, shown prominently, with an owner edit form. Saving marks both as owner-set
 * (never overwritten by reclassification) and clears a pending reclassification review.
 */
function classificationPanel(d: ItemDetail, csrf: string) {
  const { item } = d;
  const review = item.classificationReview;
  const setBy = [
    item.kindSetBy ? `kind set by ${item.kindSetBy.replace(/^human:/, '')}` : '',
    item.categorySetBy ? `category set by ${item.categorySetBy.replace(/^human:/, '')}` : '',
    item.technologiesSetBy
      ? `technologies set by ${item.technologiesSetBy.replace(/^human:/, '')}`
      : '',
  ].filter(Boolean);
  return html`<div class="classification">
      <span class="muted">Kind</span>
      <span class="cls ${item.kind ? '' : 'none'}">${item.kind ?? 'none'}</span>
      <span class="muted">Category</span>
      <span class="cls ${item.category ? '' : 'none'}">${item.category ?? 'none'}</span>
      ${setBy.length > 0 ? html`<span class="badge pass">${setBy.join(', ')}</span>` : ''}
    </div>
    ${
      review
        ? html`<div class="review">
            <strong>Reclassified (${review.promptVersion}):</strong> was
            ${review.previousKind ?? 'none'} / ${review.previousCategory ?? 'none'}, now
            ${item.kind ?? 'none'} / ${item.category ?? 'none'}. Confirm or correct it below.
          </div>`
        : ''
    }
    <form method="post" action="/items/${item.id}/classification" class="filters">
      <input type="hidden" name="csrf" value="${csrf}" />
      <select name="kind" required>
        ${KINDS.map((k) => html`<option value="${k}" ${k === item.kind ? 'selected' : ''}>${k}</option>`)}
      </select>
      <select name="category" required>
        <option value="none" ${item.category === null ? 'selected' : ''}>no category</option>
        ${CATEGORIES.map((c) => html`<option value="${c}" ${c === item.category ? 'selected' : ''}>${c}</option>`)}
      </select>
      <input
        name="technologies"
        size="28"
        value="${(item.technologies ?? []).join(', ')}"
        placeholder="technologies, e.g. prisma (empty = any project)"
        title="Products the project must use for this item to fit; empty means vendor-neutral"
      />
      <input name="reason" required minlength="3" placeholder="reason (audit log)" />
      <button>Save kind, category and technologies</button>
    </form>`;
}

export function itemPage(
  d: ItemDetail,
  reviewer: string,
  csrf: string,
  message?: { kind: 'notice' | 'error'; text: string },
): View {
  const { item } = d;
  const card = d.scorecards[0] ?? null;
  const flagged = securityFlagged(card);
  const targets = ALLOWED_TRANSITIONS[item.status as Status];
  const gates: Array<[string, GateResult | undefined]> = [
    ['Gate 0 · hygiene', card?.gateResults.gate0_hygiene],
    ['Gate 1 · provenance', card?.gateResults.gate1_provenance],
    ['Gate 2 · health', card?.gateResults.gate2_health],
    ['Gate 3 · security', card?.gateResults.gate3_security],
  ];
  const out = item.outOfScope.includes(MVP_STACK);
  return layout(
    item.name,
    html`<p><a href="/">← queue</a></p>
      <h1>${item.name} <span class="badge">${item.status}</span></h1>
      ${message ? html`<div class="${message.kind}">${message.text}</div>` : ''}
      ${classificationPanel(d, csrf)}
      ${
        flagged
          ? html`<div class="flag">
              <h3>Security flag</h3>
              <p>Gate 3 failed. Approving this item needs a written override note.</p>
              <ul>
                ${(card?.securityFindings ?? [])
                  .filter((f) => f.severity === 'high' || f.severity === 'critical')
                  .map(
                    (f) =>
                      html`<li>
                        <strong>${f.severity}</strong>:
                        ${f.description}${f.evidence ? html` — <code>${f.evidence}</code>` : ''}
                      </li>`,
                  )}
              </ul>
            </div>`
          : ''
      }
      <dl>
        <dt>Id</dt>
        <dd>${item.id}</dd>
        <dt>Source</dt>
        <dd>
          <a href="${safeHref(item.sourceUrl)}" rel="noreferrer noopener">${item.sourceUrl}</a>
        </dd>
        <dt>Technologies</dt>
        <dd>
          ${item.technologies === null ? html`<span class="muted">not classified yet</span>` : item.technologies.join(', ') || 'none (vendor-neutral)'}
        </dd>
        <dt>Stacks</dt>
        <dd>
          ${item.stacks.join(', ') || '–'}
          ${out ? html`<span class="badge not_run">out of scope for Next.js</span>` : ''}
        </dd>
        <dt>Publisher / provenance</dt>
        <dd>${item.publisher ?? '?'} / ${item.provenance ?? '?'}</dd>
        <dt>Description</dt>
        <dd>${item.description ?? '–'}</dd>
        <dt>Classifier summary</dt>
        <dd>
          ${item.classification?.summary ?? '–'}
          ${item.classification ? html`<span class="muted">(${item.classification.model}, ${item.classification.promptVersion}, relevant: ${String(item.classification.relevant)})</span>` : ''}
        </dd>
        <dt>Install</dt>
        <dd><code>${item.install ? JSON.stringify(item.install) : '–'}</code></dd>
        <dt>Capabilities</dt>
        <dd>${item.capabilities.join(', ') || '–'}</dd>
        <dt>Context overhead</dt>
        <dd>${item.contextOverheadTokens ?? '–'} tokens</dd>
        <dt>Health</dt>
        <dd>
          ${
            d.snapshot
              ? `stars ${d.snapshot.stars ?? '?'}, contributors ${d.snapshot.contributors ?? '?'}, open issues ${d.snapshot.openIssues ?? '?'}, last commit ${d.snapshot.lastCommitAt?.toISOString().slice(0, 10) ?? '?'}`
              : '–'
          }
        </dd>
        <dt>Last checked</dt>
        <dd>${item.lastChecked?.toISOString() ?? 'never'}</dd>
      </dl>

      <section>
        <h2>
          Scorecard
          ${card ? html`<span class="muted">version ${card.version} · confidence ${card.confidence}</span>` : ''}
        </h2>
        ${
          card
            ? gates.map(
                ([label, g]) =>
                  html`<h3>
                      ${label}
                      <span class="badge ${g?.result ?? 'not_run'}">${g?.result ?? 'not run'}</span>
                    </h3>
                    ${g?.notes ? html`<p>${g.notes}</p>` : ''}
                    <ul>
                      ${(g?.evidence ?? []).map(
                        (e) =>
                          html`<li>
                            ${e.label}${e.detail ? html`: ${e.detail}` : ''}
                            ${e.url ? html` <a href="${safeHref(e.url)}" rel="noreferrer noopener">link</a>` : ''}
                          </li>`,
                      )}
                    </ul>`,
              )
            : html`<p class="muted">Not gated yet.</p>`
        }
        <h3>Eval results</h3>
        ${evalSection(d)}
      </section>

      <section>
        <h2>Change status</h2>
        ${
          targets.length === 0
            ? html`<p class="muted">No transitions available from ${item.status}.</p>`
            : html`<form method="post" action="/items/${item.id}/status">
                <input type="hidden" name="csrf" value="${csrf}" />
                <label
                  >New status
                  <select name="to" required>
                    ${targets.map((t) => html`<option value="${t}">${t}</option>`)}
                  </select></label
                >
                <label>Reason (required) <textarea name="reason" required></textarea></label>
                ${
                  flagged
                    ? html`<label
                        >Security override note (required to approve this flagged item)
                        <textarea name="override"></textarea>
                      </label>`
                    : ''
                }
                <p><button>Change status as ${reviewer}</button></p>
              </form>`
        }
        <form method="post" action="/items/${item.id}/scope">
          <input type="hidden" name="csrf" value="${csrf}" />
          <input type="hidden" name="out" value="${out ? '0' : '1'}" />
          <button>${out ? 'Mark in scope for Next.js' : 'Mark out of scope for Next.js'}</button>
        </form>
      </section>

      <section>
        <h2>Audit log</h2>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Change</th>
              <th>Actor</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            ${d.events.map(
              (e) =>
                html`<tr>
                  <td>${e.createdAt.toISOString()}</td>
                  <td>${e.fromStatus ?? '(created)'} → ${e.toStatus}</td>
                  <td>${e.actor}</td>
                  <td>${e.reason}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Raw source records</h2>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>External id</th>
              <th>Intake</th>
              <th>Stars</th>
              <th>Fetched</th>
            </tr>
          </thead>
          <tbody>
            ${d.records.map(
              (r) =>
                html`<tr>
                  <td>${r.source}</td>
                  <td>${r.externalId}</td>
                  <td>${r.intakeState}</td>
                  <td>${r.stars ?? '–'}</td>
                  <td>${r.fetchedAt.toISOString().slice(0, 10)}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </section>`,
    reviewer,
    csrf,
  );
}

export function changesPage(
  changes: Array<typeof claudeCodeChanges.$inferSelect>,
  flag: string | undefined,
  reviewer: string,
  csrf: string,
): View {
  const flags = ['plugins', 'mcp', 'settings', 'hooks', 'skills', 'models'];
  return layout(
    'Claude Code changes',
    html`<h1>Claude Code changes</h1>
      <p>
        Filter: <a href="/changes">all</a>
        ${flags.map((f) => html` · <a href="/changes?flag=${f}">${f === flag ? html`<strong>${f}</strong>` : f}</a>`)}
      </p>
      ${changes.map(
        (c) =>
          html`<section>
            <h3>
              ${c.title}
              <span class="muted"
                >${c.source === 'claude_code_release' ? 'release' : 'changelog'}${c.publishedAt ? ` · ${c.publishedAt.toISOString().slice(0, 10)}` : ''}</span
              >
              ${c.flags.map((f) => html` <span class="badge soft_fail">${f}</span>`)}
            </h3>
            ${c.url ? html`<a href="${safeHref(c.url)}" rel="noreferrer noopener">source</a>` : ''}
            <pre>${c.body}</pre>
          </section>`,
      )}
      ${changes.length === 0 ? html`<p class="muted">No change notes yet. Run discovery.</p>` : ''}`,
    reviewer,
    csrf,
  );
}
