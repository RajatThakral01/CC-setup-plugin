import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  componentPaths,
  estimateComponents,
  firstPublished,
  type ComponentEstimate,
  type ComponentFile,
} from './components.js';
import type { HttpClient, Logger } from '@cc-setup-agent/core';
import {
  and,
  asc,
  catalogItems,
  eq,
  inArray,
  itemVersions,
  rawSourceRecords,
  scorecards,
  signalSnapshots,
  sql,
  statusEvents,
  desc,
  transitionStatus,
  type Db,
} from '@cc-setup-agent/db';
import {
  computeConfidence,
  type AppConfig,
  type GateResults,
  type Status,
} from '@cc-setup-agent/shared';
import type { Vendors } from '../catalog-config.js';
import type { GithubClient, RepoFacts, RepoHealth } from '../sources/github.js';
import {
  latestManifest,
  repositoryUrl,
  type NpmClient,
  type NpmPackument,
} from '../sources/npm.js';
import type { MarketplacePayload } from '../sources/marketplace.js';
import type { RegistryPayload } from '../sources/registry.js';
import { githubRepoFromRepositoryUrl, parseSourceUrl } from '../sources/urls.js';
import { gate0, gate1, gate2, gate3, type GateFacts } from './evaluate.js';
import { resolveInstall, sandboxShell, type ResolvedInstall } from './install.js';
import { osvFindings, resolveDirectDeps, type PackageVersion } from './osv.js';
import { probeRemoteServer } from './remote.js';
import {
  contextOverheadTokens,
  inferCapabilities,
  installScriptFindings,
  scanText,
  scanToolDefinitions,
  egressFindings,
  type Finding,
} from './rules.js';
import type { DockerCli } from './sandbox/docker.js';
import { probeMcpServer, sweepSandboxes, type ToolDefinition } from './sandbox/probe.js';

export interface GateDeps {
  db: Db;
  http: HttpClient;
  github: GithubClient;
  npm: NpmClient;
  docker: DockerCli;
  config: AppConfig;
  logger: Logger;
  vendors: Vendors;
}

export interface ItemGateReport {
  id: string;
  version: string;
  confidence: string;
  results: Record<string, string>;
  statusChange?: { from: Status; to: Status; reason: string };
  error?: string;
}

const SYSTEM = 'system';

type Item = typeof catalogItems.$inferSelect;

async function linkedPayload<T>(
  db: Db,
  itemId: string,
  source: 'mcp_registry' | 'marketplace',
): Promise<T | null> {
  const [row] = await db
    .select({ payload: rawSourceRecords.payload })
    .from(rawSourceRecords)
    .where(and(eq(rawSourceRecords.itemId, itemId), eq(rawSourceRecords.source, source)))
    .limit(1);
  return (row?.payload as T | undefined) ?? null;
}

async function weeklyDownloads(deps: GateDeps, name: string): Promise<number | null> {
  try {
    const base = deps.config.NPM_DOWNLOADS_URL.replace(/\/+$/, '');
    const encoded = name.startsWith('@')
      ? `@${encodeURIComponent(name.slice(1))}`
      : encodeURIComponent(name);
    const r = await deps.http.getJson(
      `${base}/downloads/point/last-week/${encoded}`,
      z.looseObject({ downloads: z.number() }),
    );
    return r.downloads;
  } catch {
    return null;
  }
}

/** Gathers everything the gates need for one item. Network-heavy; no database writes. */
export async function gatherFacts(
  deps: GateDeps,
  item: Item,
  now: Date,
): Promise<
  GateFacts & {
    toolsFromProbe: ToolDefinition[];
    componentEstimate: ComponentEstimate;
    firstPublishedAt: Date | null;
  }
> {
  const ref = parseSourceUrl(item.sourceUrl);
  const registry = await linkedPayload<RegistryPayload>(deps.db, item.id, 'mcp_registry');
  const marketplace = await linkedPayload<MarketplacePayload>(deps.db, item.id, 'marketplace');
  let npmPackument: NpmPackument | undefined;
  let repoFullName: string | null = null;
  let folder: { path: string; ref: string } | null = null;
  if (ref?.type === 'github') {
    repoFullName = `${ref.owner}/${ref.repo}`;
    if (ref.path && ref.ref) folder = { path: ref.path, ref: ref.ref };
  } else if (ref?.type === 'npm') {
    npmPackument = await deps.npm.getPackument(ref.name);
    const gh = githubRepoFromRepositoryUrl(
      repositoryUrl(npmPackument.repository ?? latestManifest(npmPackument)?.repository),
    );
    if (gh) repoFullName = `${gh.owner}/${gh.repo}`;
  }

  let repo: RepoFacts | null = null;
  let health: RepoHealth | null = null;
  let contributors: number | null = null;
  if (repoFullName) {
    repo =
      (await deps.github.getReposBatch([repoFullName])).get(repoFullName.toLowerCase()) ?? null;
    if (repo) {
      repoFullName = repo.fullName;
      health = await deps.github.getRepoHealth(repo.fullName);
      contributors = await deps.github.getContributorCount(repo.fullName).catch(() => null);
    }
  }
  const repoVersion =
    health?.latestRelease?.tag ??
    (health?.headSha ? `sha-${health.headSha.slice(0, 7)}` : 'unknown');
  const install: ResolvedInstall = await resolveInstall(
    {
      http: deps.http,
      npm: deps.npm,
      github: deps.github,
      pypiUrl: deps.config.PYPI_URL,
      registryUrl: deps.config.MCP_REGISTRY_URL,
    },
    {
      kind: item.kind,
      sourceUrl: item.sourceUrl,
      packageName: item.packageName,
      registry,
      marketplace,
      repoFullName,
      folder,
      repoVersion,
    },
  );

  // README: folder README/SKILL.md, repo README, or the package's README.
  let readme: string | undefined;
  if (repo) readme = await deps.github.getReadme(repo.fullName, folder ?? undefined);
  // A folder item without its own README is documented by its collection's README.
  if (repo && folder && (readme?.length ?? 0) < 200) {
    const collection = await deps.github.getReadme(repo.fullName);
    if ((collection?.length ?? 0) > (readme?.length ?? 0)) readme = collection;
  }
  const npmReadme = (npmPackument ?? install.npm?.packument)?.readme;
  const readmeLength = Math.max(
    readme?.length ?? 0,
    npmReadme?.length ?? 0,
    install.pypi?.readmeLength ?? 0,
  );

  // Structure checks for skills and plugins.
  let structure: GateFacts['structure'] = {
    checked: false,
    hasSkillMd: false,
    hasPluginManifest: false,
    licenseFile: false,
    frontmatterLicense: null,
  };
  let skillText: string | undefined;
  let skillPath: string | undefined;
  let inScope: string[] = [];
  if (
    repo &&
    health?.defaultBranch &&
    (item.kind === 'skill' || item.kind === 'plugin' || folder || !repo.license)
  ) {
    const tree = await deps.github
      .getTree(repo.fullName, folder?.ref ?? health.defaultBranch)
      .catch(() => null);
    if (tree && !tree.truncated) {
      const prefix = folder ? `${folder.path}/` : '';
      inScope = tree.paths.filter((p) => p.startsWith(prefix));
      skillPath = inScope.find((p) => /(^|\/)skill\.md$/i.test(p));
      structure = {
        checked: true,
        hasSkillMd: Boolean(skillPath),
        // A plugin repo may itself be a marketplace with plugins in subfolders.
        hasPluginManifest: inScope.some((p) =>
          /(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/.test(p),
        ),
        licenseFile: inScope.some((p) => /(^|\/)(LICEN[CS]E|COPYING)(\.[a-z]+)?$/i.test(p)),
        frontmatterLicense: null,
      };
      if (skillPath)
        skillText = await deps.github.getFileText(
          repo.fullName,
          skillPath,
          folder?.ref ?? health.defaultBranch,
        );
    }
  }

  // Skills, commands and agents in the tree: listed for classification and context cost.
  const componentFiles: ComponentFile[] = [];
  let bundledServers = 0;
  if (repo && health?.defaultBranch && (item.kind === 'skill' || item.kind === 'plugin')) {
    const treeRef = folder?.ref ?? health.defaultBranch;
    for (const c of componentPaths(inScope)) {
      const text =
        c.path === skillPath && skillText
          ? skillText
          : await deps.github.getFileText(repo.fullName, c.path, treeRef).catch(() => undefined);
      if (text) componentFiles.push({ ...c, text });
    }
    for (const p of inScope.filter((x) => /(^|\/)\.mcp\.json$/.test(x)).slice(0, 5)) {
      const text = await deps.github.getFileText(repo.fullName, p, treeRef).catch(() => undefined);
      try {
        const servers = text ? (JSON.parse(text) as { mcpServers?: unknown }).mcpServers : null;
        if (servers && typeof servers === 'object') bundledServers += Object.keys(servers).length;
      } catch {
        // An unparsable .mcp.json in a third-party repo is ignored here; gate 0 doesn't need it.
      }
    }
  }

  if (skillText) {
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(skillText)?.[1] ?? '';
    const license = /^license:\s*['"]?([^'"\n]+?)['"]?\s*$/im.exec(fm)?.[1];
    if (license) structure = { ...structure, frontmatterLicense: license };
  }

  // Install and start (gate 0) plus tool definitions and egress (gate 3).
  let start: GateFacts['start'] = {
    status: item.kind === 'mcp_server' ? 'not_attempted' : 'not_applicable',
    tools: [],
  };
  const findings: Finding[] = [];
  const method = install.install?.method;
  if (item.kind === 'mcp_server' && install.install && (method === 'npx' || method === 'uvx')) {
    const shell = sandboxShell(install.install);
    if (shell) {
      const probe = await probeMcpServer(
        deps.docker,
        {
          image: method === 'npx' ? deps.config.GATE_NODE_IMAGE : deps.config.GATE_PYTHON_IMAGE,
          shell,
        },
        {
          policy: {
            allowedImages: [deps.config.GATE_NODE_IMAGE, deps.config.GATE_PYTHON_IMAGE],
            tempRoot: tmpdir(),
          },
          proxyImage: deps.config.GATE_NODE_IMAGE,
          installTimeoutMs: deps.config.GATE_INSTALL_TIMEOUT_SECONDS * 1000,
          listToolsTimeoutMs: deps.config.GATE_LIST_TOOLS_TIMEOUT_SECONDS * 1000,
          limits: {
            cpus: deps.config.GATE_CPUS,
            memoryMb: deps.config.GATE_MEMORY_MB,
            pidsLimit: deps.config.GATE_PIDS_LIMIT,
          },
          platform: deps.config.GATE_PLATFORM,
        },
        deps.logger,
      );
      const detail = `${probe.error ?? 'unknown'}${probe.stderrTail ? ` | stderr: ${probe.stderrTail.slice(-300)}` : ''}`;
      start = probe.ok
        ? { status: 'ok', tools: probe.tools }
        : { status: classifyStartFailure(detail), tools: [], detail };
      findings.push(...egressFindings(probe.egress));
    } else {
      start = { status: 'not_attempted', tools: [], detail: 'install values failed validation' };
    }
  } else if (item.kind === 'mcp_server' && method === 'remote' && install.install?.url) {
    const remote = await probeRemoteServer(
      install.install.url,
      deps.config.GATE_LIST_TOOLS_TIMEOUT_SECONDS * 1000,
    );
    start = {
      status: remote.status,
      tools: remote.tools,
      ...(remote.detail ? { detail: remote.detail } : {}),
    };
  } else if (item.kind === 'mcp_server') {
    start = { status: 'not_attempted', tools: [], detail: 'no npm, PyPI or remote install found' };
  }
  findings.push(...scanToolDefinitions(start.tools));
  if (skillText)
    findings.push(
      ...scanText('SKILL.md', skillText).filter((f) => f.rule !== 'exfiltration_language'),
    );

  const packages: PackageVersion[] = [];
  if (install.npm) {
    const manifest = install.npm.packument.versions[install.npm.version];
    findings.push(
      ...installScriptFindings(
        manifest?.scripts,
        `${install.npm.packument.name}@${install.npm.version}`,
      ),
    );
    packages.push({
      ecosystem: 'npm',
      name: install.npm.packument.name,
      version: install.npm.version,
    });
    const deps2 = (manifest as { dependencies?: Record<string, string> } | undefined)?.dependencies;
    packages.push(...(await resolveDirectDeps(deps.npm, deps2)));
  }
  if (install.pypi)
    packages.push({ ecosystem: 'PyPI', name: install.pypi.name, version: install.pypi.version });
  const osv = await osvFindings(deps.http, deps.config.OSV_API_URL, packages);
  findings.push(...osv.findings);

  const vendor = repo ? deps.vendors.githubOrgs.has(repo.owner.toLowerCase()) : false;
  const downloads = install.npm ? await weeklyDownloads(deps, install.npm.packument.name) : null;
  return {
    kind: item.kind,
    sourceUrl: item.sourceUrl,
    repo,
    health,
    readmeLength,
    structure,
    install,
    start,
    vendor,
    contributors,
    weeklyDownloads: downloads,
    findings,
    scanned: { tools: start.tools.length > 0, text: Boolean(skillText), packages: osv.checked },
    now,
    toolsFromProbe: start.tools,
    componentEstimate: estimateComponents(componentFiles, start.tools, bundledServers),
    firstPublishedAt: firstPublished(
      repo?.createdAt,
      (npmPackument ?? install.npm?.packument)?.time?.['created'],
    ),
  };
}

/**
 * Install failures (package can't be resolved or downloaded) are hard; anything after install,
 * typically missing credentials, arguments or an unexpected entry point, leaves start unverified.
 */
export function classifyStartFailure(detail: string): 'failed' | 'needs_config' {
  return /unsatisfiable|no matching distribution|no version of|ETARGET|E404|404 Not Found|notarget|No solution found|package not found/i.test(
    detail,
  )
    ? 'failed'
    : 'needs_config';
}

/** Status change implied by gate results, if any (FR-C0, FR-C2, FR-C3). */
export function statusChangeFor(
  status: Status,
  outcome: {
    block: boolean;
    hygieneFailures: string[];
    abandoned: boolean;
    rejectedBySystem?: boolean;
  },
): { to: Status; reason: string } | null {
  if (outcome.block && status !== 'blocked')
    return {
      to: 'blocked',
      reason: 'gate 3: confirmed prompt injection in tool definitions or instructions',
    };
  // A gate-0 rejection made by the system is lifted when a later check passes; human rejections stay.
  if (
    status === 'rejected' &&
    outcome.rejectedBySystem &&
    outcome.hygieneFailures.length === 0 &&
    !outcome.block
  ) {
    return { to: 'candidate', reason: 'gate 0 re-check passes' };
  }
  if (outcome.hygieneFailures.length > 0) {
    const reason = `gate 0: ${outcome.hygieneFailures.join('; ')}`;
    if (status === 'candidate' || status === 'watchlist') return { to: 'rejected', reason };
    // An approved item that fails install or start in a re-check goes to watchlist (PRD FR-P6).
    if (status === 'recommended' || status === 'recommended_provisional')
      return { to: 'watchlist', reason };
  }
  if (outcome.abandoned && (status === 'recommended' || status === 'recommended_provisional')) {
    return { to: 'watchlist', reason: `gate 2: no commit for more than 180 days` };
  }
  return null;
}

/** Runs gates 0–3 for one item and stores the scorecard (FR-C6). */
export async function gateItem(
  deps: GateDeps,
  item: Item,
  now = new Date(),
): Promise<ItemGateReport> {
  const facts = await gatherFacts(deps, item, now);
  const g0 = gate0(facts);
  const g1 = gate1(facts);
  const g2 = gate2(facts);
  const g3 = gate3(facts);
  const gateResults: GateResults = {
    gate0_hygiene: g0.result,
    gate1_provenance: g1.result,
    gate2_health: g2.result,
    gate3_security: g3.result,
  };
  const { confidence } = computeConfidence(gateResults);
  const version = facts.install.version;
  const tools = facts.toolsFromProbe;
  const securityFindings = facts.findings.map(({ severity, description, evidence }) => ({
    severity,
    description,
    ...(evidence ? { evidence } : {}),
  }));

  await deps.db.transaction(async (tx) => {
    await tx
      .insert(scorecards)
      .values({
        itemId: item.id,
        version,
        gateResults,
        securityFindings,
        confidence,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [scorecards.itemId, scorecards.version],
        set: { gateResults, securityFindings, confidence, updatedAt: now },
      });
    await tx.update(itemVersions).set({ pinned: false }).where(eq(itemVersions.itemId, item.id));
    await tx
      .insert(itemVersions)
      .values({
        itemId: item.id,
        version,
        pinned: true,
        releasedAt: facts.health?.latestRelease?.publishedAt
          ? new Date(facts.health.latestRelease.publishedAt)
          : null,
      })
      .onConflictDoUpdate({
        target: [itemVersions.itemId, itemVersions.version],
        set: { pinned: true },
      });
    await tx
      .update(catalogItems)
      .set({
        provenance: g1.provenance,
        install: facts.install.install,
        lastChecked: now,
        components: { ...facts.componentEstimate.components, collectedAt: now.toISOString() },
        ...(facts.firstPublishedAt ? { firstPublishedAt: facts.firstPublishedAt } : {}),
        ...(tools.length > 0
          ? {
              capabilities: inferCapabilities(tools, item.kind),
              contextOverheadTokens: contextOverheadTokens(tools),
            }
          : item.kind === 'hook_recipe'
            ? { capabilities: ['shell'] }
            : {}),
        ...(tools.length === 0 && facts.componentEstimate.alwaysTokens !== null
          ? {
              contextOverheadTokens: facts.componentEstimate.alwaysTokens,
              contextOnUseTokens: facts.componentEstimate.onUseTokens,
            }
          : {}),
      })
      .where(eq(catalogItems.id, item.id));
    if (facts.repo) {
      await tx.insert(signalSnapshots).values({
        itemId: item.id,
        capturedAt: now,
        stars: facts.repo.stars,
        lastCommitAt: g2.lastCommitAt ? new Date(g2.lastCommitAt) : null,
        openIssues: facts.health?.openIssues ?? null,
        medianIssueResponseHours: facts.health?.medianIssueResponseHours ?? null,
        contributors: facts.contributors,
        downloads7d: facts.weeklyDownloads,
      });
    }
  });

  const report: ItemGateReport = {
    id: item.id,
    version,
    confidence,
    results: Object.fromEntries(Object.entries(gateResults).map(([k, v]) => [k, v.result])),
  };
  const rejectedBySystem =
    item.status === 'rejected' && (await lastStatusActor(deps.db, item.id)) === SYSTEM;
  const change = statusChangeFor(item.status, {
    block: g3.block,
    hygieneFailures: g0.failures,
    abandoned: g2.abandoned,
    rejectedBySystem,
  });
  if (change) {
    await transitionStatus(deps.db, item.id, change.to, SYSTEM, change.reason);
    report.statusChange = { from: item.status, ...change };
  }
  return report;
}

async function lastStatusActor(db: Db, itemId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ actor: statusEvents.actor })
    .from(statusEvents)
    .where(eq(statusEvents.itemId, itemId))
    .orderBy(desc(statusEvents.id))
    .limit(1);
  return row?.actor;
}

export type GateSelection = { itemIds: string[] } | { mode: 'pending' | 'recheck' };

/**
 * Items to gate. `pending`: never scored, not rejected or blocked (in-scope first).
 * `recheck` (FR-C8): recommended items not checked for GATE_RECHECK_DAYS.
 */
export async function selectItems(
  db: Db,
  selection: GateSelection,
  config: AppConfig,
  now = new Date(),
): Promise<Item[]> {
  if ('itemIds' in selection) {
    return selection.itemIds.length === 0
      ? []
      : db.select().from(catalogItems).where(inArray(catalogItems.id, selection.itemIds));
  }
  if (selection.mode === 'pending') {
    return db
      .select()
      .from(catalogItems)
      .where(
        and(
          sql`not exists (select 1 from ${scorecards} s where s.item_id = ${catalogItems.id})`,
          sql`${catalogItems.status} not in ('rejected', 'blocked')`,
        ),
      )
      .orderBy(
        sql`cardinality(${catalogItems.outOfScope}) > 0`,
        asc(catalogItems.firstSeen),
        asc(catalogItems.id),
      );
  }
  const stale = new Date(now.getTime() - config.GATE_RECHECK_DAYS * 86_400_000);
  return db
    .select()
    .from(catalogItems)
    .where(
      and(
        inArray(catalogItems.status, ['recommended', 'recommended_provisional']),
        sql`coalesce(${catalogItems.lastChecked}, 'epoch') < ${stale}`,
      ),
    )
    .orderBy(asc(catalogItems.lastChecked));
}

/** Runs gates for the selected items with limited concurrency. One item's failure never stops the rest. */
export async function runGates(
  deps: GateDeps,
  selection: GateSelection,
  options: { limit?: number } = {},
): Promise<ItemGateReport[]> {
  await sweepSandboxes(deps.docker).catch((e: unknown) =>
    deps.logger.warn({ err: e }, 'sandbox sweep failed'),
  );
  const items = (await selectItems(deps.db, selection, deps.config)).slice(
    0,
    options.limit ?? Infinity,
  );
  const reports: ItemGateReport[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        const report = await gateItem(deps, item);
        reports.push(report);
        deps.logger.info(
          {
            id: item.id,
            confidence: report.confidence,
            results: report.results,
            statusChange: report.statusChange?.to,
          },
          'gates done',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reports.push({
          id: item.id,
          version: 'unknown',
          confidence: 'n/a',
          results: {},
          error: message,
        });
        deps.logger.error({ id: item.id, err: error }, 'gates failed for item');
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(deps.config.GATE_CONCURRENCY, items.length) }, worker),
  );
  return reports;
}
