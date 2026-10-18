/** Fake GitHub API payloads with obviously fake names. */
export function fakeRepo(fullName: string, overrides: Record<string, unknown> = {}) {
  const [owner, name] = fullName.split('/');
  return {
    id: Math.abs([...fullName].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)),
    full_name: fullName,
    name,
    owner: { login: owner, type: 'Organization' },
    html_url: `https://github.com/${fullName}`,
    description: `Fake repository ${fullName}`,
    fork: false,
    archived: false,
    license: { spdx_id: 'MIT' },
    stargazers_count: 42,
    pushed_at: '2026-10-01T00:00:00Z',
    created_at: '2025-01-01T00:00:00Z',
    default_branch: 'main',
    topics: ['mcp-server'],
    ...overrides,
  };
}

export function fakePackument(
  name: string,
  overrides: { deprecated?: string; repository?: string } = {},
) {
  return {
    name,
    description: `Fake package ${name}`,
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '0.9.0': { version: '0.9.0' },
      '1.0.0': {
        version: '1.0.0',
        ...(overrides.deprecated ? { deprecated: overrides.deprecated } : {}),
        ...(overrides.repository ? { repository: { type: 'git', url: overrides.repository } } : {}),
      },
    },
    time: {
      created: '2025-01-01T00:00:00Z',
      modified: '2026-10-01T00:00:00Z',
      '1.0.0': '2026-10-01T00:00:00Z',
    },
  };
}
