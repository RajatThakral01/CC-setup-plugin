import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalError } from '../errors.js';
import type { ToolOverrides } from '../tools.js';
import type { DockerCli } from './docker.js';

const EVALS_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const DOCKERFILE = join(EVALS_DIR, 'docker', 'Dockerfile');
export const BUILD_CONTEXT = join(EVALS_DIR, 'fixtures');
const IGNORED = new Set(['node_modules', '.next', 'test-results', 'playwright-report']);

export interface ImageInputs {
  baseImage: string;
  claudeCodeVersion: string;
  /** Extra Playwright versions whose Chromium builds the tools under test need (tools.yaml). */
  playwrightVersions: string[];
}

export function imageInputs(
  baseImage: string,
  claudeCodeVersion: string,
  overrides: ToolOverrides,
): ImageInputs {
  const versions = new Set(Object.values(overrides).flatMap((o) => o.playwrightBrowsers));
  return { baseImage, claudeCodeVersion, playwrightVersions: [...versions].sort() };
}

async function contextFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await contextFiles(full)));
    else if (e.isFile()) out.push(full);
  }
  return out.sort();
}

/** `ccsa-eval:<hash>` over the Dockerfile, the fixture app and the build arguments. */
export async function imageTag(inputs: ImageInputs): Promise<string> {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(inputs));
  hash.update(await readFile(DOCKERFILE));
  for (const f of await contextFiles(BUILD_CONTEXT)) {
    hash.update(relative(BUILD_CONTEXT, f).split(sep).join('/'));
    hash.update(await readFile(f));
  }
  return `ccsa-eval:${hash.digest('hex').slice(0, 16)}`;
}

export async function imageExists(docker: DockerCli, tag: string): Promise<boolean> {
  return (await docker.exec(['image', 'inspect', tag])).code === 0;
}

/** Builds the eval image (needs network; installs only into the image, never on the host). */
export async function buildImage(
  docker: DockerCli,
  inputs: ImageInputs,
  platform?: string,
): Promise<string> {
  const tag = await imageTag(inputs);
  const r = await docker.exec(
    [
      'build',
      '-f',
      DOCKERFILE,
      '--build-arg',
      `BASE_IMAGE=${inputs.baseImage}`,
      '--build-arg',
      `CLAUDE_CODE_VERSION=${inputs.claudeCodeVersion}`,
      '--build-arg',
      `EXTRA_PLAYWRIGHT_VERSIONS=${inputs.playwrightVersions.join(' ')}`,
      '--label',
      'ccsa.eval-image=1',
      ...(platform ? ['--platform', platform] : []),
      '-t',
      tag,
      BUILD_CONTEXT,
    ],
    { timeoutMs: 45 * 60_000 },
  );
  if (r.code !== 0) throw new EvalError(`image build failed: ${r.stderr.trim().slice(-2000)}`);
  return tag;
}

/** Claude Code version actually inside the image (pinned per run, FR-E5). */
export async function imageClaudeVersion(docker: DockerCli, tag: string): Promise<string> {
  const r = await docker.exec(['run', '--rm', '--network', 'none', tag, 'claude', '--version']);
  const v = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
  if (r.code !== 0 || !v) throw new EvalError(`can't read the Claude Code version in ${tag}`);
  return v;
}
