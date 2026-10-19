import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Digest, DigestEntry } from '@cc-setup-agent/db';

/** Markdown-safe one-line text: no pipes or newlines from third-party data. */
const cell = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
const link = (label: string, url: string) =>
  /^https:\/\//i.test(url) ? `[${cell(label)}](${url})` : cell(label);

function entryLines(e: DigestEntry, triageUrl: string): string[] {
  const s = e.evalSummary;
  return [
    `- **${cell(e.name)}** (\`${e.itemId}\`): ${e.from ?? 'new'} → ${e.to}, ${e.at.toISOString().slice(0, 16).replace('T', ' ')} UTC, by \`${e.actor}\``,
    `  - Why: ${cell(e.reason)}`,
    `  - Evidence: ${[
      link('source', e.sourceUrl),
      `[triage](${triageUrl}/items/${encodeURIComponent(e.itemId)})`,
      ...e.evidence.map((x) => link(x.label, x.url)),
    ].join(' · ')}`,
    ...(s
      ? [
          `  - Eval: ${s.verdict} vs ${s.baselineItemId ?? 'no tool'}, ${Math.round(s.successRate * 100)}% vs ${s.baselineSuccessRate === null ? 'n/a' : `${Math.round(s.baselineSuccessRate * 100)}%`} (${s.model}, ${s.runs} runs)`,
        ]
      : []),
  ];
}

/** The weekly digest as markdown (PRD FR-P8). Nothing in it asks the owner to do anything. */
export function renderDigestMarkdown(d: Digest, triageUrl: string): string {
  const section = (title: string, list: DigestEntry[], empty: string) => [
    `## ${title} (${list.length})`,
    '',
    ...(list.length === 0 ? [empty] : list.flatMap((e) => entryLines(e, triageUrl))),
    '',
  ];
  return [
    `# Catalog digest, week of ${d.weekStart}`,
    '',
    `What the approval policy did between ${d.weekStart} and ${d.weekEnd} (UTC). No action is needed; to overrule anything, use **Veto** on the item's triage page.`,
    '',
    d.latestPolicyRun
      ? `Latest policy run: \`${d.latestPolicyRun.version}\` at ${d.latestPolicyRun.at.toISOString().slice(0, 16).replace('T', ' ')} UTC, ${d.latestPolicyRun.evaluated} items evaluated.`
      : 'The policy has not run yet.',
    `Eval runs this week: ${d.evals.runs} (USD ${d.evals.costUsd.toFixed(4)}). Anthropic spend this week: USD ${d.spend.weekUsd.toFixed(4)}.`,
    '',
    ...section('Approved (recommended_provisional)', d.approved, 'None this week.'),
    ...section('Promoted (recommended)', d.promoted, 'None this week.'),
    ...section('Demoted', d.demoted, 'None this week.'),
    ...section('Owner vetoes', d.vetoes, 'None this week.'),
    '## Not approved: why',
    '',
    ...(d.heldByCriterion.length === 0
      ? ['No held items.']
      : [
          '| Failing criterion | Items |',
          '| --- | --- |',
          ...d.heldByCriterion.map((h) => `| ${h.criterion} | ${h.items} |`),
        ]),
    '',
  ].join('\n');
}

/** Writes `digest-<week>.md` into the reports directory (from config); returns the path. */
export async function writeReport(dir: string, name: string, content: string): Promise<string> {
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  const path = join(target, name);
  await writeFile(path, content, 'utf8');
  return path;
}
