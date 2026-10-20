import { describe, expect, it } from 'vitest';
import { bundledInstall, configPaths, parseBundledServers, splitNpmSpec } from './bundled.js';

describe('bundled MCP servers', () => {
  it('reads both .mcp.json shapes: a top-level map and mcpServers', () => {
    const top = parseBundledServers(
      JSON.stringify({ example: { command: 'npx', args: ['-y', '@example/mcp-alpha@1.2.3'] } }),
    );
    const wrapped = parseBundledServers(
      JSON.stringify({
        mcpServers: { remote: { type: 'http', url: 'https://mcp.example.test/' } },
      }),
    );
    expect(top).toEqual([
      { name: 'example', type: 'npm', package: '@example/mcp-alpha', version: '1.2.3' },
    ]);
    expect(wrapped).toEqual([{ name: 'remote', type: 'remote', url: 'https://mcp.example.test/' }]);
  });

  it('treats latest, ranges and missing versions as unpinned', () => {
    expect(splitNpmSpec('@example/mcp@latest')).toEqual({ package: '@example/mcp', version: null });
    expect(splitNpmSpec('example-mcp@^1.0.0').version).toBeNull();
    expect(splitNpmSpec('example-mcp').version).toBeNull();
    expect(splitNpmSpec('@example/mcp')).toEqual({ package: '@example/mcp', version: null });
  });

  it('builds sandbox installs only for pinned packages', () => {
    const [pinned, unpinned, uvx, other] = parseBundledServers(
      JSON.stringify({
        a: { command: 'npx', args: ['example-mcp@0.1.0'] },
        b: { command: 'npx', args: ['example-mcp@latest'] },
        c: { command: 'uvx', args: ['--from', 'example-py==2.0.0', 'example-py'] },
        d: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] },
      }),
    );
    expect(bundledInstall(pinned!)).toMatchObject({
      method: 'npx',
      package: 'example-mcp',
      version: '0.1.0',
    });
    expect(bundledInstall(unpinned!)).toBeNull();
    expect(bundledInstall(uvx!)).toMatchObject({
      method: 'uvx',
      package: 'example-py',
      version: '2.0.0',
    });
    expect(other).toMatchObject({ type: 'other' });
  });

  it('ignores unparsable files and entries that are not servers', () => {
    expect(parseBundledServers('{not json')).toEqual([]);
    expect(parseBundledServers(JSON.stringify({ description: 'x' }))).toEqual([]);
  });

  it('finds the config files Claude Code reads', () => {
    expect(
      configPaths([
        'p/.mcp.json',
        'p/hooks/hooks.json',
        'p/.claude-plugin/plugin.json',
        'p/README.md',
        'p/hooks/run.sh',
      ]),
    ).toEqual(['p/.claude-plugin/plugin.json', 'p/.mcp.json', 'p/hooks/hooks.json']);
  });
});
