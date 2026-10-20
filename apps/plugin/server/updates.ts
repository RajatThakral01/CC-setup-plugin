import { join } from 'node:path';
import type { Snapshot, SnapshotItem } from '@cc-setup-agent/shared';
import { readText } from './files.js';

export interface UpdateNotice {
  id: string;
  type: 'blocked' | 'deprecated' | 'superseded' | 'new_version' | 'not_in_catalog';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  replacementId?: string;
}

/** Package spec `name@version` / `name==version` from server args, if any. */
function installedPackage(entry: {
  args?: unknown;
}): { name: string; version: string | null } | null {
  const args = Array.isArray(entry.args)
    ? entry.args.filter((a): a is string => typeof a === 'string')
    : [];
  for (const a of args) {
    const npm = /^(@?[^@\s]+)@([^@\s]+)$/.exec(a);
    if (npm?.[1] && !a.startsWith('-')) return { name: npm[1], version: npm[2] ?? null };
    const py = /^([A-Za-z0-9._-]+)==(\S+)$/.exec(a);
    if (py?.[1]) return { name: py[1], version: py[2] ?? null };
  }
  return null;
}

function match(
  snapshot: Snapshot,
  name: string,
  entry: { args?: unknown; url?: unknown },
): { item: SnapshotItem; installedVersion: string | null } | null {
  const pkg = installedPackage(entry);
  const byName = snapshot.items.find((i) => i.id === name);
  if (byName) return { item: byName, installedVersion: pkg?.version ?? null };
  if (pkg) {
    const byPkg = snapshot.items.find((i) => i.install?.package === pkg.name);
    if (byPkg) return { item: byPkg, installedVersion: pkg.version };
  }
  if (typeof entry.url === 'string') {
    const byUrl = snapshot.items.find((i) => i.install?.url === entry.url);
    if (byUrl) return { item: byUrl, installedVersion: null };
  }
  return null;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

/** Compares installed MCP servers with the catalog (FR-U1, FR-U2). Blocked items come first. */
export async function checkUpdates(root: string, snapshot: Snapshot): Promise<UpdateNotice[]> {
  const raw = await readText(join(root, '.mcp.json'));
  if (raw === null) return [];
  let servers: Record<string, { args?: unknown; url?: unknown }> = {};
  try {
    servers = (JSON.parse(raw) as { mcpServers?: typeof servers }).mcpServers ?? {};
  } catch {
    return [
      {
        id: '.mcp.json',
        type: 'not_in_catalog',
        severity: 'warning',
        message: '.mcp.json is not valid JSON.',
      },
    ];
  }
  const notices: UpdateNotice[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    // A version that stays blocked after its item's block was lifted (PRD FR-P10).
    const pkg = installedPackage(entry);
    const blockedVersion = pkg?.version
      ? snapshot.blockedVersions.find(
          (b) => (b.id === name || b.package === pkg.name) && b.versions.includes(pkg.version!),
        )
      : undefined;
    if (blockedVersion) {
      notices.push({
        id: name,
        type: 'blocked',
        severity: 'critical',
        message: `${blockedVersion.name} ${pkg!.version} is BLOCKED in the catalog (security). Update it or remove it from .mcp.json now.`,
      });
      continue;
    }
    const m = match(snapshot, name, entry);
    if (!m) {
      notices.push({
        id: name,
        type: 'not_in_catalog',
        severity: 'info',
        message: `${name} is not in the catalog; kept as is.`,
      });
      continue;
    }
    const { item, installedVersion } = m;
    const replacement = item.supersededBy ? { replacementId: item.supersededBy } : {};
    if (item.status === 'blocked') {
      notices.push({
        id: name,
        type: 'blocked',
        severity: 'critical',
        message: `${item.name} is BLOCKED in the catalog (security). Remove it from .mcp.json now.`,
        ...replacement,
      });
    } else if (item.status === 'deprecated') {
      notices.push({
        id: name,
        type: 'deprecated',
        severity: 'warning',
        message: `${item.name} is deprecated.`,
        ...replacement,
      });
    } else if (item.supersededBy) {
      notices.push({
        id: name,
        type: 'superseded',
        severity: 'warning',
        message: `${item.name} has been superseded by ${item.supersededBy}.`,
        ...replacement,
      });
    } else if (
      installedVersion &&
      item.install?.version &&
      installedVersion !== item.install.version
    ) {
      notices.push({
        id: name,
        type: 'new_version',
        severity: 'info',
        message: `${item.name} ${installedVersion} is installed; the catalog pins ${item.install.version}.`,
      });
    }
  }
  return notices.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id),
  );
}

/** One-line warnings for blocked items already installed (shown on every analyze, FR-U2). */
export async function blockedWarnings(root: string, snapshot: Snapshot | null): Promise<string[]> {
  if (!snapshot) return [];
  return (await checkUpdates(root, snapshot))
    .filter((n) => n.type === 'blocked')
    .map((n) => n.message);
}
