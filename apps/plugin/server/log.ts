/**
 * Minimal JSON logger to stderr: stdout carries the MCP protocol, and the plugin bundle stays small.
 * Never pass secret values to it.
 */
export function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields })}\n`,
  );
}
