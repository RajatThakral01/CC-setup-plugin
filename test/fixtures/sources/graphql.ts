/** Fake GitHub GraphQL repository nodes in the shape the batch lookup expects. */
export function gqlRepo(fullName: string, overrides: Record<string, unknown> = {}) {
  const [owner = '', name = ''] = fullName.split('/');
  return {
    databaseId: Math.abs([...fullName].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)),
    nameWithOwner: fullName,
    name,
    owner: { login: owner },
    description: `Fake repository ${fullName}`,
    isFork: false,
    isArchived: false,
    licenseInfo: { spdxId: 'MIT' },
    stargazerCount: 42,
    pushedAt: '2026-10-10T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    defaultBranchRef: { name: 'main' },
    ...overrides,
  };
}
