import { describe, expect, it } from 'vitest';
import { assertSupportedVersion, detectClaudeCodeVersion, parseVersion } from './cc-version.js';

describe('Claude Code version gate (NFR-9)', () => {
  it('accepts the current and previous minor', () => {
    expect(assertSupportedVersion('2.1.303 (Claude Code)')).toBe('2.1.303');
    expect(assertSupportedVersion('2.0.0')).toBe('2.0.0');
  });

  it('refuses older, newer and unknown versions with a reason', () => {
    expect(() => assertSupportedVersion('1.0.128')).toThrow(/too old.*claude update/);
    expect(() => assertSupportedVersion('2.2.0')).toThrow(/newer than setup-agent/);
    expect(() => assertSupportedVersion('3.0.1')).toThrow(/newer/);
    expect(() => assertSupportedVersion(null)).toThrow(/Couldn't detect/);
    expect(() => assertSupportedVersion('unknown')).toThrow(/Couldn't detect/);
  });

  it('parses versions from CLI output', () => {
    expect(parseVersion('2.1.303 (Claude Code)')).toEqual([2, 1, 303]);
    expect(parseVersion('nope')).toBeNull();
  });

  it('prefers the MCP handshake and falls back to the CLI', async () => {
    const cli = async () => '2.1.9 (Claude Code)';
    expect(await detectClaudeCodeVersion({ name: 'claude-code', version: '2.1.303' }, cli)).toBe(
      '2.1.303',
    );
    expect(await detectClaudeCodeVersion({ name: 'other-client', version: '9.9.9' }, cli)).toBe(
      '2.1.9 (Claude Code)',
    );
    expect(await detectClaudeCodeVersion(undefined, async () => null)).toBeNull();
  });
});
