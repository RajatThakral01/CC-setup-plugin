import type { HttpClient } from '@cc-setup-agent/core';
import type { Source } from '@cc-setup-agent/shared';
import type { GithubClient } from './github.js';

/** A Claude Code change note for the owner (FR-D1); not an installable catalog item. */
export interface ChangeNote {
  source: Extract<Source, 'claude_code_changelog' | 'claude_code_release'>;
  externalId: string;
  version: string;
  title: string;
  body: string;
  flags: string[];
  url: string | null;
  publishedAt: Date | null;
}

/** Topics that can affect generated config or recommendations. */
const FLAG_PATTERNS: Array<[string, RegExp]> = [
  ['plugins', /\bplugins?\b|marketplace/i],
  ['mcp', /\bmcp\b/i],
  ['settings', /\bsettings?\b|settings\.json|\bpermissions?\b/i],
  ['hooks', /\bhooks?\b/i],
  ['skills', /\bskills?\b/i],
  ['models', /\bmodels?\b|\bopus\b|\bsonnet\b|\bhaiku\b|\beffort\b/i],
];

export function flagsFor(text: string): string[] {
  return FLAG_PATTERNS.filter(([, re]) => re.test(text)).map(([flag]) => flag);
}

/** Splits CHANGELOG.md into `## <version>` sections, newest first, at most `max`. */
export function parseChangelog(
  markdown: string,
  max: number,
): Array<{ version: string; body: string }> {
  const sections: Array<{ version: string; body: string }> = [];
  let current: { version: string; lines: string[] } | undefined;
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+v?(\d+\.\d+\.\d+[^\s]*)\s*$/.exec(line);
    if (heading?.[1]) {
      if (current)
        sections.push({ version: current.version, body: current.lines.join('\n').trim() });
      if (sections.length >= max) return sections;
      current = { version: heading[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current && sections.length < max)
    sections.push({ version: current.version, body: current.lines.join('\n').trim() });
  return sections;
}

export interface ChangelogOptions {
  rawUrl: string;
  repo: string;
  maxVersions: number;
}

export async function fetchChangeNotes(
  deps: { http: HttpClient; github: GithubClient },
  options: ChangelogOptions,
): Promise<ChangeNote[]> {
  const raw = options.rawUrl.replace(/\/+$/, '');
  const markdown = await deps.http.getText(`${raw}/${options.repo}/main/CHANGELOG.md`);
  const changelog: ChangeNote[] = parseChangelog(markdown, options.maxVersions).map((s) => ({
    source: 'claude_code_changelog',
    externalId: s.version,
    version: s.version,
    title: `Claude Code ${s.version}`,
    body: s.body,
    flags: flagsFor(s.body),
    url: `https://github.com/${options.repo}/blob/main/CHANGELOG.md`,
    publishedAt: null,
  }));
  const releases = (await deps.github.getReleases(options.repo, Math.min(options.maxVersions, 100)))
    .filter((r) => !r.draft)
    .map((r): ChangeNote => ({
      source: 'claude_code_release',
      externalId: String(r.id),
      version: r.tag_name.replace(/^v/, ''),
      title: r.name ?? r.tag_name,
      body: r.body ?? '',
      flags: flagsFor(r.body ?? ''),
      url: r.html_url,
      publishedAt: r.published_at ? new Date(r.published_at) : null,
    }));
  return [...changelog, ...releases];
}
