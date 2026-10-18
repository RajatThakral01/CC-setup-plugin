import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition } from './sandbox/probe.js';

export interface RemoteProbe {
  status: 'ok' | 'auth_required' | 'failed';
  tools: ToolDefinition[];
  detail?: string;
}

/**
 * Connects to a remote (HTTP) MCP server without credentials and lists its tools. No third-party
 * code runs locally, so no sandbox is needed; 401/403 means the server needs an account.
 */
export async function probeRemoteServer(url: string, timeoutMs: number): Promise<RemoteProbe> {
  const client = new Client({ name: 'cc-setup-agent-gates', version: '0.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: timeoutMs });
    const page = await client.listTools(undefined, { timeout: timeoutMs });
    return { status: 'ok', tools: page.tools as ToolDefinition[] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid_token|authentication|authorization header|no token|api[ _-]?key|access token|credentials?/i.test(
        message,
      )
    ) {
      return { status: 'auth_required', tools: [], detail: message.slice(0, 200) };
    }
    return { status: 'failed', tools: [], detail: message.slice(0, 200) };
  } finally {
    await client.close().catch(() => undefined);
  }
}
