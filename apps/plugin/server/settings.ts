import { homedir } from 'node:os';
import { join } from 'node:path';
import { SNAPSHOT_PUBLIC_KEY_PEM } from '@cc-setup-agent/shared';

/** Plugin settings, from the environment Claude Code passes to the MCP server (see .mcp.json). */
export interface PluginSettings {
  /** Persistent folder for the synced catalog (${CLAUDE_PLUGIN_DATA}). */
  dataDir: string;
  /** Folder URL holding `latest.json` (file:// or https://); undefined when not configured. */
  catalogUrl: string | undefined;
  publicKeyPem: string;
  staleAfterDays: number;
  contextWarnTokens: number;
  verifyTimeoutMs: number;
  /** PyPI base URL for checking pinned uvx packages in verify_setup. */
  pypiUrl: string;
}

export function settingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PluginSettings {
  const nonEmpty = (v: string | undefined) =>
    v && v.trim() !== '' && !v.includes('${') ? v.trim() : undefined;
  return {
    dataDir: nonEmpty(env['PLUGIN_DATA_DIR']) ?? join(homedir(), '.cc-setup-agent'),
    catalogUrl: nonEmpty(env['CC_SETUP_AGENT_CATALOG_URL']),
    publicKeyPem: SNAPSHOT_PUBLIC_KEY_PEM,
    staleAfterDays: 7,
    contextWarnTokens: Number(nonEmpty(env['CC_SETUP_AGENT_CONTEXT_WARN_TOKENS']) ?? 15000),
    verifyTimeoutMs: 15_000,
    pypiUrl: (nonEmpty(env['CC_SETUP_AGENT_PYPI_URL']) ?? 'https://pypi.org').replace(/\/+$/, ''),
  };
}
