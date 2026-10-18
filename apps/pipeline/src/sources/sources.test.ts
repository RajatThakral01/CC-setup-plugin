import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@cc-setup-agent/core';
import { graphqlRoute, json, text } from '../../../../test/support/fake-fetch.js';
import { fakeHttp } from '../../../../test/support/http.js';
import { gqlRepo } from '../../../../test/fixtures/sources/graphql.js';
import { fakeRepo } from '../../../../test/fixtures/sources/github.js';
import { fetchChangeNotes, flagsFor, parseChangelog } from './changelog.js';
import { createGithubClient } from './github.js';
import { fetchGithubSearch, normalizeGithubRepo } from './github-search.js';
import {
  fetchMarketplaces,
  normalizeMarketplace,
  parseMarketplaceUrl,
  type MarketplacePayload,
} from './marketplace.js';
import { fetchRegistry, normalizeRegistry, type RegistryPayload } from './registry.js';

const GH = 'https://api.github.test';
const RAW = 'https://raw.githubusercontent.com';
const REG = 'https://registry.example.test/v0.1';
const fixture = (name: string) =>
  readFileSync(new URL(`../../../../test/fixtures/sources/${name}`, import.meta.url), 'utf8');
const logger = createLogger({ level: 'silent' });

function clients(routes: Parameters<typeof fakeHttp>[0]) {
  const { http, calls } = fakeHttp(routes);
  return { http, calls, github: createGithubClient(http, 'test-token', GH), logger };
}

describe('GitHub GraphQL batch lookup', () => {
  it('returns facts, null for missing repos, and splits large batches', async () => {
    const batches: number[] = [];
    const repos = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `example-org/repo-${i}`,
        gqlRepo(`example-org/repo-${i}`),
      ]),
    );
    const { github } = clients({ [`${GH}/graphql`]: graphqlRoute(repos, (n) => batches.push(n)) });
    const names = [...Object.keys(repos), 'example-org/missing'];
    const facts = await github.getReposBatch(names);
    expect(batches).toEqual([50, 11]);
    expect(facts.get('example-org/repo-3')).toMatchObject({
      fullName: 'example-org/repo-3',
      stars: 42,
      license: 'MIT',
      fork: false,
    });
    expect(facts.get('example-org/missing')).toBeNull();
  });

  it('maps an unrecognised licence file to NOASSERTION and none to null', async () => {
    const { github } = clients({
      [`${GH}/graphql`]: graphqlRoute({
        'example-org/a': gqlRepo('example-org/a', { licenseInfo: { spdxId: null } }),
        'example-org/b': gqlRepo('example-org/b', { licenseInfo: null }),
      }),
    });
    const facts = await github.getReposBatch(['example-org/a', 'Example-Org/B']);
    expect(facts.get('example-org/a')?.license).toBe('NOASSERTION');
    expect(facts.get('example-org/b')?.license).toBeNull();
  });
});

describe('MCP Registry source', () => {
  const page = JSON.parse(fixture('registry-page.json')) as unknown;
  const since = new Date('2026-10-18T00:00:00.000Z');
  const url = `${REG}/servers?updated_since=2026-10-18T00%3A00%3A00.000Z&limit=100&version=latest`;

  it('fetches latest servers and enriches them with repo facts', async () => {
    const { http, github } = clients({
      [url]: json(page),
      [`${GH}/graphql`]: graphqlRoute({
        'example-org/example-mcp-alpha': gqlRepo('example-org/example-mcp-alpha', {
          stargazerCount: 120,
        }),
        'example-user/example-monorepo': gqlRepo('example-user/example-monorepo'),
      }),
    });
    const records = await fetchRegistry(
      { http, github, logger },
      { registryUrl: REG, maxPages: 5 },
      since,
    );
    expect(records.map((r) => r.externalId)).toEqual([
      'test.example/example-mcp-alpha',
      'test.example/example-remote-only',
      'io.github.example-user/example-monorepo-server',
    ]);
    const [alpha, remote, mono] = records.map((r) =>
      normalizeRegistry(r.payload as RegistryPayload),
    );
    expect(alpha).toMatchObject({
      name: 'Example MCP Alpha',
      sourceUrl: 'https://github.com/example-org/example-mcp-alpha',
      packageName: '@example/mcp-alpha',
      kind: 'mcp_server',
      publisher: 'example-org',
      registry: { isLatest: true, namespace: 'test.example', hasRepoUrl: true },
    });
    expect(alpha?.repo?.stars).toBe(120);
    expect(remote).toMatchObject({ sourceUrl: null, repo: null, registry: { hasRepoUrl: false } });
    expect(mono?.sourceUrl).toBe(
      'https://github.com/example-user/example-monorepo/tree/main/packages/server',
    );
  });

  it('follows cursors across pages', async () => {
    const first = { servers: [], metadata: { nextCursor: 'c1' } };
    const firstWithItem = {
      ...first,
      servers: (page as { servers: unknown[] }).servers.slice(1, 2),
    };
    const { http, github, calls } = clients({
      [url]: json(firstWithItem),
      [`${url}&cursor=c1`]: json({
        servers: (page as { servers: unknown[] }).servers.slice(0, 1),
        metadata: {},
      }),
      [`${GH}/graphql`]: graphqlRoute({}),
    });
    const records = await fetchRegistry(
      { http, github, logger },
      { registryUrl: REG, maxPages: 5 },
      since,
    );
    expect(records).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith(REG))).toHaveLength(2);
  });
});

describe('marketplace source', () => {
  const mpUrl = `${RAW}/example-org/example-marketplace/main/.claude-plugin/marketplace.json`;

  it('parses marketplace URLs', () => {
    expect(parseMarketplaceUrl(mpUrl)).toEqual({
      url: mpUrl,
      fullName: 'example-org/example-marketplace',
      ref: 'main',
    });
    expect(parseMarketplaceUrl('https://example.test/marketplace.json')).toBeUndefined();
  });

  it('resolves every source type to a canonical GitHub URL', async () => {
    const { http, github } = clients({
      [mpUrl]: text(fixture('marketplace.json')),
      [`${GH}/graphql`]: graphqlRoute({
        'example-org/example-marketplace': gqlRepo('example-org/example-marketplace'),
        'example-vendor/example-url-plugin': gqlRepo('example-vendor/example-url-plugin'),
        'example-vendor/example-plugins': gqlRepo('example-vendor/example-plugins'),
        'example-community/example-github-plugin': gqlRepo(
          'example-community/example-github-plugin',
          { defaultBranchRef: { name: 'trunk' } },
        ),
      }),
    });
    const records = await fetchMarketplaces({ http, github, logger }, [mpUrl]);
    const drafts = Object.fromEntries(
      records.map((r) => [r.externalId, normalizeMarketplace(r.payload as MarketplacePayload)]),
    );
    expect(drafts['example-marketplace:example-relative-plugin']?.sourceUrl).toBe(
      'https://github.com/example-org/example-marketplace/tree/main/plugins/example-relative-plugin',
    );
    expect(drafts['example-marketplace:example-url-plugin']?.sourceUrl).toBe(
      'https://github.com/example-vendor/example-url-plugin',
    );
    expect(drafts['example-marketplace:example-subdir-plugin']?.sourceUrl).toBe(
      'https://github.com/example-vendor/example-plugins/tree/v1.5.5/plugins/example-subdir-plugin',
    );
    expect(drafts['example-marketplace:example-github-plugin']?.sourceUrl).toBe(
      'https://github.com/example-community/example-github-plugin',
    );
    expect(drafts['example-marketplace:example-npm-plugin']).toMatchObject({
      sourceUrl: null,
      repo: null,
    });
    expect(Object.values(drafts).every((d) => d.kind === 'plugin')).toBe(true);
    expect(drafts['example-marketplace:example-relative-plugin']?.publisher).toBe('Example Org');
  });

  it('keeps going when one marketplace fails, and fails only if all do', async () => {
    const bad = `${RAW}/example-org/broken/main/.claude-plugin/marketplace.json`;
    const { http, github } = clients({
      [mpUrl]: text(fixture('marketplace.json')),
      [bad]: () => new Response('', { status: 500 }),
      [`${GH}/graphql`]: graphqlRoute({}),
    });
    await expect(fetchMarketplaces({ http, github, logger }, [bad, mpUrl])).resolves.toHaveLength(
      5,
    );
    await expect(fetchMarketplaces({ http, github, logger }, [bad])).rejects.toThrow(
      /all marketplaces failed/,
    );
  });
});

describe('GitHub search source', () => {
  it('searches each topic in the window, pages, dedupes by repo id and pauses between calls', async () => {
    const now = new Date('2026-10-19T02:00:00Z');
    const q = (topic: string, page: number) =>
      `${GH}/search/repositories?q=${encodeURIComponent(`topic:${topic} pushed:>=2026-10-12`)}&sort=updated&order=desc&per_page=100&page=${page}`;
    const shared = fakeRepo('example-org/shared-repo');
    const pageOne = Array.from({ length: 100 }, (_, i) => fakeRepo(`example-org/repo-${i}`));
    const sleeps: number[] = [];
    const { github } = clients({
      [q('mcp-server', 1)]: json({ total_count: 101, items: pageOne }),
      [q('mcp-server', 2)]: json({ total_count: 101, items: [shared] }),
      [q('claude-code', 1)]: json({ total_count: 1, items: [shared] }),
    });
    const records = await fetchGithubSearch(
      { github, logger },
      {
        topics: ['mcp-server', 'claude-code'],
        windowDays: 7,
        maxPages: 10,
        intervalMs: 2500,
        sleep: async (ms) => void sleeps.push(ms),
      },
      now,
    );
    expect(records).toHaveLength(101);
    expect(sleeps).toEqual([2500, 2500]);
    expect(normalizeGithubRepo(records[0]?.payload)).toMatchObject({
      sourceUrl: 'https://github.com/example-org/repo-0',
      kind: null,
    });
  });

  it('normalizes seed folder payloads to folder URLs', () => {
    const repo = fakeRepo('example-org/example-plugins');
    expect(
      normalizeGithubRepo({ repo, path: 'plugins/alpha', ref: 'main', directory: [] }),
    ).toMatchObject({
      name: 'alpha',
      sourceUrl: 'https://github.com/example-org/example-plugins/tree/main/plugins/alpha',
      folder: { path: 'plugins/alpha', ref: 'main' },
    });
    expect(normalizeGithubRepo({ nothing: true })).toBeNull();
  });
});

describe('Claude Code changelog source', () => {
  it('splits versions newest first and respects the limit', () => {
    const sections = parseChangelog(fixture('changelog.md'), 2);
    expect(sections.map((s) => s.version)).toEqual(['9.9.3', '9.9.2']);
    expect(sections[0]?.body).toContain('permissions.example');
  });

  it('flags config-relevant topics', () => {
    expect(flagsFor('Added a permissions setting; fixed MCP reconnects')).toEqual([
      'mcp',
      'settings',
    ]);
    expect(flagsFor('Plugins can declare hooks')).toEqual(['plugins', 'hooks']);
    expect(flagsFor('New default effort for Sonnet models')).toEqual(['models']);
    expect(flagsFor('Fixed a typo')).toEqual([]);
  });

  it('fetches changelog sections and releases', async () => {
    const { http, github } = clients({
      [`${RAW}/example-org/example-cli/main/CHANGELOG.md`]: text(fixture('changelog.md')),
      [`${GH}/repos/example-org/example-cli/releases?per_page=30`]: json([
        {
          id: 7,
          tag_name: 'v9.9.3',
          name: 'v9.9.3',
          body: '- Fixed MCP servers',
          html_url: 'https://github.com/example-org/example-cli/releases/v9.9.3',
          published_at: '2026-10-16T20:53:06Z',
          draft: false,
        },
        {
          id: 8,
          tag_name: 'v9.9.4',
          name: null,
          body: null,
          html_url: 'https://example.test',
          published_at: null,
          draft: true,
        },
      ]),
    });
    const notes = await fetchChangeNotes(
      { http, github },
      { rawUrl: RAW, repo: 'example-org/example-cli', maxVersions: 30 },
    );
    expect(notes.filter((n) => n.source === 'claude_code_changelog').map((n) => n.version)).toEqual(
      ['9.9.3', '9.9.2', '9.9.1'],
    );
    expect(notes.filter((n) => n.source === 'claude_code_release')).toEqual([
      expect.objectContaining({ externalId: '7', version: '9.9.3', flags: ['mcp'] }),
    ]);
  });
});
