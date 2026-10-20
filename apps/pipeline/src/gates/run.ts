import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  componentPaths,
  estimateComponents,
  firstPublished,
  type ComponentEstimate,
  type ComponentFile,
} from './components.js';
import type { HttpClient, LlmClient, Logger } from '@cc-setup-agent/core';
import {
  acceptedVersion,
  acceptVersion,
  and,
  asc,
  catalogItems,
  eq,
  inArray,
  itemVersions,
  or,
  rawSourceRecords,
  scorecards,
  signalSnapshots,
  sql,
  statusEvents,
  desc,
  holdChange,
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
import {
  bundledInstall,
  configPaths,
  describeBundled,
  parseBundledServers,
  type BundledServer,
} from './bundled.js';
import { gate0, gate1, gate2, gate3, type GateFacts } from './evaluate.js';
import { resolveInstall, sandboxShell, type ResolvedInstall } from './install.js';
import { osvFindings, resolveDirectDeps, type PackageVersion } from './osv.js';
import { probeRemoteServer } from './remote.js';
import { reviewTriggers, SCANNER_VERSION } from './review.js';
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
  /** Reviews gate 3 rule matches (M10 safeguard a). Without it every match stays suspected. */
  llm?: LlmClient;
  /**
   * Whether SCANNER_VERSION is the accepted scanner (M10 safeguard c). When false, new blocks and
   * demotions are held for the owner. `runGates` sets it; direct callers default to accepted.
   */
  scannerAccepted?: boolean;
}

export interface ItemGateReport {
  id: string;
  version: string;
  confidence: string;
  results: Record<string, string>;
  statusChange?: { from: Status; to: Status; reason: string };
  /** A change held for the owner instead of applied (unaccepted scanner version). */
  held?: { from: Status; to: Status; reason: string };
  error?: string;
}

const SYSTEM = 'system';
/** Statuses a block or demotion takes an item out of (held while a scanner is unaccepted). */
const APPROVED: ReadonlySet<Status> = new Set(['recommended', 'recommended_provisional']);
export const BLOCKED_RECHECK_DAYS = 7;

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

/**
 * Gate 3 on instruction and config text that only M8.3 started scanning (every skill, command and
 * agent body, config files, the marketplace entry). Hidden content keeps its full weight (Unicode
 * tag characters still block; invisible or bidi characters still flag). The phrase rules were
 * written for MCP tool descriptions, where text should never instruct the model; skill and agent
 * bodies instruct the model by design, and configuration guidance mentions `.env` constantly, so
 * phrase and sensitive-path matches here are recorded as low-severity evidence, not verdicts. The
 * first SKILL.md keeps the M4 rules unchanged.
 */
export function instructionTextFindings(where: string, text: string): Finding[] {
  const HIDDEN = new Set(['unicode_tag_chars', 'invisible_unicode']);
  return scanText(where, text).map((f): Finding => {
    if (HIDDEN.has(f.rule)) return f;
    // Recorded as evidence only, so there is nothing for the review to decide.
    const rest = { ...f };
    delete rest.trigger;
    return {
      ...rest,
      severity: 'low',
      confirmed: false,
      description: `${f.description} (instruction wording; recorded, not a verdict)`,
    };
  });
}

/** Sandbox options for probing an MCP server (the item itself or one a plugin bundles). */
function probeOptions(deps: GateDeps): Parameters<typeof probeMcpServer>[2] {
  return {
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
  };
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
  const bundled: BundledServer[] = [];
  // Gate 3 scans everything a skill or plugin adds (M8.3): every command, agent and skill text,
  // the config files Claude Code reads, and the marketplace entry.
  const textFindings: Finding[] = [];
  let configScanned = false;
  if (repo && health?.defaultBranch && (item.kind === 'skill' || item.kind === 'plugin')) {
    const treeRef = folder?.ref ?? health.defaultBranch;
    for (const c of componentPaths(inScope)) {
      const text =
        c.path === skillPath && skillText
          ? skillText
          : await deps.github.getFileText(repo.fullName, c.path, treeRef).catch(() => undefined);
      if (text) componentFiles.push({ ...c, text });
    }
    for (const f of componentFiles)
      if (f.path !== skillPath)
        textFindings.push(
          ...instructionTextFindings(f.path, f.text).filter(
            (x) => x.rule !== 'exfiltration_language',
          ),
        );
    for (const p of configPaths(inScope)) {
      const text = await deps.github.getFileText(repo.fullName, p, treeRef).catch(() => undefined);
      if (!text) continue;
      configScanned = true;
      textFindings.push(...instructionTextFindings(p, text));
      if (/(^|\/)\.mcp\.json$/.test(p)) bundled.push(...parseBundledServers(text));
    }
  }
  if (marketplace) {
    configScanned = true;
    textFindings.push(...instructionTextFindings('marketplace entry', JSON.stringify(marketplace)));
  }
  const bundledServers = bundled.length;

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
        probeOptions(deps),
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
  findings.push(...scanToolDefinitions(start.tools), ...textFindings);

  // Bundled MCP servers (plugins): pinned packages are probed in the sandbox and checked in OSV;
  // unpinned ones are flagged; the rest can't be verified, which keeps gate 3 from passing.
  const bundledTools: ToolDefinition[] = [];
  const bundledPackages: PackageVersion[] = [];
  const unprobed: string[] = [];
  for (const server of bundled.slice(0, 5)) {
    const install = bundledInstall(server);
    if (install) {
      const shell = sandboxShell(install);
      const probe = shell
        ? await probeMcpServer(
            deps.docker,
            {
              image:
                install.method === 'npx'
                  ? deps.config.GATE_NODE_IMAGE
                  : deps.config.GATE_PYTHON_IMAGE,
              shell,
            },
            probeOptions(deps),
            deps.logger,
          )
        : null;
      bundledPackages.push({
        ecosystem: install.method === 'npx' ? 'npm' : 'PyPI',
        name: install.package!,
        version: install.version!,
      });
      if (probe?.ok) {
        bundledTools.push(...probe.tools);
        findings.push(...scanToolDefinitions(probe.tools), ...egressFindings(probe.egress));
      } else unprobed.push(`${describeBundled(server)}: did not start in the sandbox`);
    } else if (server.type === 'npm' || server.type === 'pypi') {
      findings.push({
        rule: 'unpinned_bundled_server',
        severity: 'medium',
        confirmed: false,
        description: `Bundled MCP server ${server.name} runs ${server.package} without an exact version`,
        evidence: describeBundled(server),
      });
      unprobed.push(`${describeBundled(server)}: not pinned`);
    } else if (server.type === 'remote') {
      const remote = await probeRemoteServer(
        server.url,
        deps.config.GATE_LIST_TOOLS_TIMEOUT_SECONDS * 1000,
      );
      if (remote.status === 'ok') {
        bundledTools.push(...remote.tools);
        findings.push(...scanToolDefinitions(remote.tools));
      } else unprobed.push(`${describeBundled(server)}: ${remote.status}`);
    } else unprobed.push(`${describeBundled(server)}: not a package we can probe`);
  }
  if (bundled.length > 5) unprobed.push(`${bundled.length - 5} more bundled server(s) not probed`);
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
  packages.push(...bundledPackages);
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
    scanned: {
      tools: start.tools.length > 0 || bundledTools.length > 0,
      text: Boolean(skillText) || componentFiles.length > 0,
      config: configScanned,
      packages: osv.checked,
    },
    bundled: { servers: bundled.length, unprobed },
    now,
    toolsFromProbe: start.tools,
    componentEstimate: estimateComponents(
      componentFiles,
      [...start.tools, ...bundledTools],
      bundledServers,
    ),
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
    suspected?: boolean;
    hygieneFailures: string[];
    abandoned: boolean;
    rejectedBySystem?: boolean;
  },
): { to: Status; reason: string } | null {
  if (outcome.block && status !== 'blocked')
    return {
      to: 'blocked',
      reason:
        'gate 3: confirmed prompt injection in tool definitions or instructions (rule match confirmed by an independent review)',
    };
  if (outcome.suspected && status !== 'blocked')
    return {
      to: 'blocked',
      reason:
        'gate 3: suspected prompt injection (rule match not confirmed by an independent review); lifted after a clean re-check',
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
  const gathered = await gatherFacts(deps, item, now);
  // A rule match is only a trigger: an independent review confirms, clears or suspects it.
  const reviewed = await reviewTriggers(
    gathered.findings,
    { ...(deps.llm ? { llm: deps.llm } : {}), model: deps.config.MODEL_FAST, logger: deps.logger },
    `gate3:${item.id}`,
  );
  const facts = { ...gathered, findings: reviewed.findings };
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
  const securityFindings = facts.findings.map(
    ({ rule, severity, description, evidence, review }) => ({
      rule,
      severity,
      description,
      ...(evidence ? { evidence } : {}),
      ...(review ? { review } : {}),
    }),
  );

  await deps.db.transaction(async (tx) => {
    await tx
      .insert(scorecards)
      .values({
        itemId: item.id,
        version,
        gateResults,
        securityFindings,
        confidence,
        scannerVersion: SCANNER_VERSION,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [scorecards.itemId, scorecards.version],
        set: {
          gateResults,
          securityFindings,
          confidence,
          scannerVersion: SCANNER_VERSION,
          updatedAt: now,
        },
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
    suspected: g3.suspected,
    hygieneFailures: g0.failures,
    abandoned: g2.abandoned,
    rejectedBySystem,
  });
  if (change) {
    const block =
      change.to === 'blocked'
        ? {
            cause: g3.block ? ('injection' as const) : ('suspected_injection' as const),
            findings: securityFindings
              .filter((f) => f.severity === 'critical')
              .map((f) => f.description),
          }
        : undefined;
    // New blocks and demotions from a scanner version nobody accepted yet wait for the owner.
    const demotes = change.to === 'blocked' || APPROVED.has(item.status);
    if (deps.scannerAccepted === false && demotes) {
      await holdChange(deps.db, {
        itemId: item.id,
        from: item.status,
        to: change.to,
        actor: SYSTEM,
        reason: change.reason,
        ...(block ? { block } : {}),
        source: 'gates',
        trigger: 'scanner_change',
        versions: { scanner: SCANNER_VERSION },
      });
      report.held = { from: item.status, ...change };
      return report;
    }
    await transitionStatus(
      deps.db,
      item.id,
      change.to,
      SYSTEM,
      change.reason,
      block ? { block } : {},
    );
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

export type GateSelection = { itemIds: string[] } | { mode: 'pending' | 'recheck' | 'all' };

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
  if (selection.mode === 'all') {
    return db
      .select()
      .from(catalogItems)
      .where(sql`${catalogItems.status} <> 'rejected'`)
      .orderBy(asc(catalogItems.id));
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
  // Items the policy blocked for vulnerable dependencies are re-checked weekly, so a fixed
  // version can lift the block (PRD FR-P10).
  const blockedStale = new Date(now.getTime() - BLOCKED_RECHECK_DAYS * 86_400_000);
  return db
    .select()
    .from(catalogItems)
    .where(
      or(
        and(
          inArray(catalogItems.status, ['recommended', 'recommended_provisional']),
          sql`coalesce(${catalogItems.lastChecked}, 'epoch') < ${stale}`,
        ),
        and(
          eq(catalogItems.status, 'blocked'),
          sql`${catalogItems.blockRecord}->>'cause' = 'vulnerable_dependency'`,
          sql`${catalogItems.blockRecord}->>'by' like 'policy:%'`,
          sql`coalesce(${catalogItems.lastChecked}, 'epoch') < ${blockedStale}`,
        ),
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
  const acceptedScanner = await acceptedVersion(deps.db, 'scanner');
  deps = { ...deps, scannerAccepted: acceptedScanner === SCANNER_VERSION };
  if (!deps.scannerAccepted)
    deps.logger.warn(
      { accepted: acceptedScanner, current: SCANNER_VERSION },
      'scanner version not accepted yet: new blocks and demotions are held for the owner',
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
  // A new scanner takes effect on its own only after a clean dry run over the whole catalog.
  if (
    !deps.scannerAccepted &&
    'mode' in selection &&
    selection.mode === 'all' &&
    options.limit === undefined &&
    reports.every((r) => !r.error && !r.held)
  ) {
    await acceptVersion(deps.db, 'scanner', SCANNER_VERSION, 'system: clean full dry run');
    deps.logger.info({ version: SCANNER_VERSION }, 'scanner version accepted after a clean run');
  }
  return reports;
}
