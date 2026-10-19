import type { Logger } from '@cc-setup-agent/core';
import type { GithubClient } from '../sources/github.js';
import type { NpmClient } from '../sources/npm.js';
import { parseSourceUrl } from '../sources/urls.js';

export async function fetchReadme(
  deps: { github: GithubClient; npm: NpmClient; logger: Logger },
  sourceUrl: string,
): Promise<string | null> {
  const ref = parseSourceUrl(sourceUrl);
  try {
    if (ref?.type === 'github') {
      const folder = ref.path && ref.ref ? { path: ref.path, ref: ref.ref } : undefined;
      return (await deps.github.getReadme(`${ref.owner}/${ref.repo}`, folder)) ?? null;
    }
    if (ref?.type === 'npm') return (await deps.npm.getPackument(ref.name)).readme ?? null;
  } catch (error) {
    // A missing README lowers classification quality but must not block it.
    deps.logger.warn({ sourceUrl, err: error }, 'readme fetch failed; classifying without it');
  }
  return null;
}
