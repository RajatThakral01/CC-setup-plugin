import type { ItemComponents } from '@cc-setup-agent/shared';
import type { ToolDefinition } from './sandbox/probe.js';

/**
 * Components an item adds to Claude Code and the context they cost (PRD FR-C5, M8.2).
 *
 * What loads into context, per code.claude.com/docs (skills, plugins/overview; 2026-10-19,
 * Claude Code 2.1.303): for every skill, command and agent Claude can invoke on its own, the name
 * and description are in context on every turn (the combined description is cut at 1,536
 * characters in the skill listing; `disable-model-invocation: true` keeps it out); the body of a
 * skill or command loads only when it's used. MCP servers add their tool definitions every turn.
 */

/** Description characters the skill listing keeps per entry. */
export const LISTING_DESCRIPTION_CHARS = 1536;
/** Per-entry framing in the listing (name, separators), in tokens. */
const ENTRY_OVERHEAD_TOKENS = 8;
/** At most this many component files are fetched per item. */
export const MAX_COMPONENT_FILES = 60;
const DESCRIPTION_KEEP = 300;

const tokens = (chars: number) => Math.ceil(chars / 4);

export interface ComponentFile {
  type: 'skills' | 'commands' | 'agents';
  path: string;
  text: string;
}

/** Simple YAML frontmatter fields (`key: value`, quoted or folded on one line). */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    // Block scalars (`>` or `|`): join the indented lines that follow.
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(' ');
    }
    fields[kv[1]!] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return { fields, body: text.slice(m[0].length) };
}

/** Component files in an item's tree (paths already limited to the item's folder). */
export function componentPaths(paths: string[]): Array<Omit<ComponentFile, 'text'>> {
  const out: Array<Omit<ComponentFile, 'text'>> = [];
  for (const path of paths) {
    if (/(^|\/)skill\.md$/i.test(path)) out.push({ type: 'skills', path });
    else if (/(^|\/)commands\/[^/]+\.md$/i.test(path)) out.push({ type: 'commands', path });
    else if (/(^|\/)agents\/[^/]+\.md$/i.test(path)) out.push({ type: 'agents', path });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_COMPONENT_FILES);
}

const nameFromPath = (f: Omit<ComponentFile, 'text'>) => {
  const parts = f.path.split('/');
  const file = parts.at(-1)!.replace(/\.md$/i, '');
  return f.type === 'skills' ? (parts.at(-2) ?? file) : file;
};

export interface ComponentEstimate {
  components: Omit<ItemComponents, 'collectedAt'>;
  /** Always-loaded tokens (descriptions, or tool definitions). Null when nothing was measured. */
  alwaysTokens: number | null;
  /** Largest single body that loads on use. */
  onUseTokens: number | null;
}

/** Builds the component list and the context estimate from fetched files and probed tools. */
export function estimateComponents(
  files: ComponentFile[],
  tools: ToolDefinition[],
  mcpServers: number,
): ComponentEstimate {
  const components: ComponentEstimate['components'] = {
    tools: tools.map((t) => ({
      name: t.name,
      description: (t.description ?? '').slice(0, DESCRIPTION_KEEP),
    })),
    skills: [],
    commands: [],
    agents: [],
    mcpServers,
  };
  let listing = 0;
  let onUse = 0;
  for (const f of files) {
    const { fields, body } = parseFrontmatter(f.text);
    const name = fields['name'] || nameFromPath(f);
    const description = [fields['description'], fields['when_to_use']].filter(Boolean).join(' ');
    components[f.type].push({ name, description: description.slice(0, DESCRIPTION_KEEP) });
    if (fields['disable-model-invocation'] !== 'true')
      listing +=
        tokens(name.length + Math.min(description.length, LISTING_DESCRIPTION_CHARS)) +
        ENTRY_OVERHEAD_TOKENS;
    if (f.type !== 'agents') onUse = Math.max(onUse, tokens(body.length));
  }
  const toolTokens = tools.length > 0 ? tokens(JSON.stringify(tools).length) : 0;
  const measured = files.length > 0 || tools.length > 0;
  return {
    components,
    alwaysTokens: measured ? listing + toolTokens : null,
    onUseTokens: onUse > 0 ? onUse : null,
  };
}

/** Earliest of the repo's creation and the package's first publication. */
export function firstPublished(...dates: Array<string | null | undefined>): Date | null {
  const times = dates
    .filter((d): d is string => typeof d === 'string' && d !== '')
    .map((d) => Date.parse(d))
    .filter(Number.isFinite);
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}
