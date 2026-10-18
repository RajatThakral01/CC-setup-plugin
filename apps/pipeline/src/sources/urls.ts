/** Parsed form of a catalog source URL. */
export type SourceRef =
  | { type: 'github'; owner: string; repo: string; ref?: string; path?: string }
  | { type: 'npm'; name: string };

const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/**
 * Accepts https://github.com/<owner>/<repo>, https://github.com/<owner>/<repo>/tree/<ref>/<path>,
 * and https://www.npmjs.com/package/<name> (scoped or not). Returns undefined for anything else.
 */
export function parseSourceUrl(raw: string): SourceRef | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repoRaw, kind, ref, ...rest] = parts;
    if (!owner || !repoRaw) return undefined;
    const repo = repoRaw.replace(/\.git$/, '');
    if (kind === undefined) return { type: 'github', owner, repo };
    if (kind === 'tree' && ref && rest.length > 0) {
      return { type: 'github', owner, repo, ref, path: rest.join('/') };
    }
    return undefined;
  }
  if (host === 'www.npmjs.com' || host === 'npmjs.com') {
    if (parts[0] !== 'package') return undefined;
    const name = parts[1]?.startsWith('@') ? `${parts[1]}/${parts[2] ?? ''}` : parts[1];
    return name && NPM_NAME.test(name) ? { type: 'npm', name } : undefined;
  }
  return undefined;
}

export function githubSourceUrl(fullName: string, ref?: string, path?: string): string {
  const base = `https://github.com/${fullName}`;
  return ref && path ? `${base}/tree/${ref}/${path}` : base;
}

export function npmSourceUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`;
}

/** owner/repo from a package.json-style repository URL, if it points at GitHub. */
export function githubRepoFromRepositoryUrl(
  raw: string | undefined,
): { owner: string; repo: string } | undefined {
  if (!raw) return undefined;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(raw);
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : undefined;
}

/** Lowercase, dash-separated slug usable as a catalog item id. */
export function slugify(...parts: string[]): string {
  const slug = parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug.slice(0, 120).replace(/-+$/, '');
}
