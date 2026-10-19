import { execFile } from 'node:child_process';
import { PluginError } from './files.js';

/**
 * Supported Claude Code versions (NFR-9: the current and the previous minor). Config shapes were
 * verified against 2.1.302/2.1.303 (docs/DECISIONS.md). Raise `below` after re-verifying the
 * generated files against a new minor.
 */
export const SUPPORTED_CLAUDE_CODE = { from: '2.0.0', below: '2.2.0' } as const;

type Triple = [number, number, number];

export function parseVersion(text: string): Triple | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const RANGE_TEXT = '2.0.x or 2.1.x';

/** Throws a clear PluginError unless the version is in the supported range. */
export function assertSupportedVersion(version: string | null): string {
  const v = version ? parseVersion(version) : null;
  if (!v)
    throw new PluginError(
      `Couldn't detect the Claude Code version, so no config was generated. setup-agent writes config only for Claude Code ${RANGE_TEXT}; check \`claude --version\`.`,
    );
  const text = v.join('.');
  if (compare(v, parseVersion(SUPPORTED_CLAUDE_CODE.from)!) < 0)
    throw new PluginError(
      `Claude Code ${text} is too old for setup-agent, so no config was generated. Update Claude Code to ${RANGE_TEXT} (\`claude update\`) and run /setup again.`,
    );
  if (compare(v, parseVersion(SUPPORTED_CLAUDE_CODE.below)!) >= 0)
    throw new PluginError(
      `Claude Code ${text} is newer than setup-agent has been verified against (${RANGE_TEXT}), so no config was generated: the config format may have changed. Update the setup-agent plugin, or use Claude Code ${RANGE_TEXT}.`,
    );
  return text;
}

/** `claude --version` output, or null when the CLI isn't on PATH. */
export function claudeVersionFromCli(timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: timeoutMs }, (error, stdout) =>
      resolve(error ? null : stdout.trim() || null),
    );
  });
}

/**
 * The running Claude Code version: from the MCP handshake (Claude Code identifies itself as
 * `claude-code`), else from `claude --version`.
 */
export async function detectClaudeCodeVersion(
  clientInfo: { name: string; version: string } | undefined,
  fromCli: () => Promise<string | null> = claudeVersionFromCli,
): Promise<string | null> {
  if (clientInfo?.name === 'claude-code' && parseVersion(clientInfo.version))
    return clientInfo.version;
  return fromCli();
}
