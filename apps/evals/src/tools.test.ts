import { describe, expect, it } from 'vitest';
import { json, text } from '../../../test/support/fake-fetch.js';
import { fakeHttp } from '../../../test/support/http.js';
import { createSkillFetcher, parseTreeUrl, type EvalItem } from './tools.js';

const API = 'https://api.github.test';
const RAW = 'https://raw.github.test';
const SHA = 'a'.repeat(40);

describe('parseTreeUrl', () => {
  it('reads folder URLs and repo roots', () => {
    expect(parseTreeUrl('https://github.com/example-org/skills/tree/main/skills/x')).toEqual({
      repo: 'example-org/skills',
      ref: 'main',
      path: 'skills/x',
    });
    expect(parseTreeUrl('https://github.com/example-org/example-skill')).toEqual({
      repo: 'example-org/example-skill',
      ref: null,
      path: '',
    });
    expect(parseTreeUrl('https://example.test/x')).toBeNull();
  });
});

describe('createSkillFetcher for a skill at the root of its repo', () => {
  const item = (version = 'sha-aaaaaaa'): EvalItem => ({
    id: 'example-skill',
    kind: 'skill',
    install: {
      method: 'skill_copy',
      url: 'https://github.com/example-org/example-skill',
      envVars: [],
    },
    version,
    sourceUrl: 'https://github.com/example-org/example-skill',
    contextOverheadTokens: null,
  });
  const routes = (tree: Array<{ path: string; size: number }>) => ({
    [`${API}/repos/example-org/example-skill/commits/aaaaaaa`]: json({ sha: SHA }),
    [`${API}/repos/example-org/example-skill/git/trees/${SHA}?recursive=1`]: json({
      sha: SHA,
      truncated: false,
      tree: tree.map((t) => ({ ...t, type: 'blob' })),
    }),
    ...Object.fromEntries(
      tree.map((t) => [`${RAW}/example-org/example-skill/${SHA}/${t.path}`, text(`# ${t.path}`)]),
    ),
  });

  it('copies the skill files at the pinned commit, without repo plumbing or binaries', async () => {
    const { http } = fakeHttp(
      routes([
        { path: 'SKILL.md', size: 100 },
        { path: 'core/guide.md', size: 300_000 },
        { path: '.github/workflows/ci.yml', size: 50 },
        { path: 'assets/logo.png', size: 5_000 },
        { path: 'core/huge.md', size: 900_000 },
      ]),
    );
    const files = await createSkillFetcher(http, { apiUrl: API, rawUrl: RAW })(item());
    expect(files.map((f) => f.path)).toEqual(['SKILL.md', 'core/guide.md']);
  });

  it('refuses a repo without a SKILL.md at its root', async () => {
    const { http } = fakeHttp(routes([{ path: 'docs/SKILL.md', size: 100 }]));
    await expect(createSkillFetcher(http, { apiUrl: API, rawUrl: RAW })(item())).rejects.toThrow(
      /no SKILL.md at the root/,
    );
  });
});
