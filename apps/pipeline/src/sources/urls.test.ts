import { describe, expect, it } from 'vitest';
import { githubRepoFromRepositoryUrl, parseSourceUrl, slugify } from './urls.js';

describe('parseSourceUrl', () => {
  it.each([
    [
      'https://github.com/example-org/example-mcp',
      { type: 'github', owner: 'example-org', repo: 'example-mcp' },
    ],
    [
      'https://github.com/example-org/example-mcp.git',
      { type: 'github', owner: 'example-org', repo: 'example-mcp' },
    ],
    [
      'https://github.com/example-org/plugins/tree/main/plugins/alpha',
      { type: 'github', owner: 'example-org', repo: 'plugins', ref: 'main', path: 'plugins/alpha' },
    ],
    ['https://www.npmjs.com/package/example-mcp', { type: 'npm', name: 'example-mcp' }],
    ['https://www.npmjs.com/package/@example/mcp', { type: 'npm', name: '@example/mcp' }],
  ])('parses %s', (url, expected) => {
    expect(parseSourceUrl(url)).toEqual(expected);
  });

  it.each([
    'http://github.com/a/b',
    'https://github.com/only-owner',
    'https://github.com/a/b/blob/main/README.md',
    'https://gitlab.com/a/b',
    'https://www.npmjs.com/org/example',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parseSourceUrl(url)).toBeUndefined();
  });
});

describe('githubRepoFromRepositoryUrl', () => {
  it.each([
    ['git+https://github.com/example-org/example-mcp.git', 'example-mcp'],
    ['git@github.com:example-org/example-mcp.git', 'example-mcp'],
    ['https://github.com/example-org/example-mcp/tree/main/packages/x', 'example-mcp'],
    ['github.com/example-org/example-mcp#readme', 'example-mcp'],
  ])('extracts repo from %s', (url, repo) => {
    expect(githubRepoFromRepositoryUrl(url)).toEqual({ owner: 'example-org', repo });
  });
  it('ignores non-GitHub repositories', () => {
    expect(githubRepoFromRepositoryUrl('https://gitlab.com/a/b')).toBeUndefined();
  });
});

describe('slugify', () => {
  it('builds lowercase dash slugs', () => {
    expect(slugify('Example-Org', 'My_MCP.Server')).toBe('example-org-my-mcp-server');
    expect(slugify('@example/mcp')).toBe('example-mcp');
  });
});
