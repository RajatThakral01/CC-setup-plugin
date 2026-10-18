import { describe, expect, it } from 'vitest';
import { assertModelAllowed, parseConfig, requireSecret } from './config.js';
import { ConfigError } from './errors.js';

describe('parseConfig', () => {
  it('applies defaults for an empty environment', () => {
    const config = parseConfig({});
    expect(config.MODEL_FAST).toBe('claude-haiku-5-5');
    expect(config.MODEL_STRONG).toBe('claude-sonnet-5-5');
    expect(config.WEEKLY_BUDGET_USD).toBe(20);
    expect(config.TOTAL_BUDGET_USD).toBe(40);
    expect(config.TOTAL_BUDGET_WARN_USD).toBe(30);
    expect(config.ALLOWED_MODELS).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(config.MODEL_PRICING_JSON['claude-haiku-5-5']?.inputPerMTok).toBe(0.1);
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('coerces numeric variables', () => {
    const config = parseConfig({ WEEKLY_BUDGET_USD: '12.5', TRIAGE_PORT: '5000' });
    expect(config.WEEKLY_BUDGET_USD).toBe(12.5);
    expect(config.TRIAGE_PORT).toBe(5000);
  });

  it('treats blank secrets as unset', () => {
    expect(parseConfig({ GITHUB_TOKEN: '  ' }).GITHUB_TOKEN).toBeUndefined();
  });

  it.each([
    ['MODEL_FAST', 'claude-opus-5-5'],
    ['MODEL_STRONG', 'CLAUDE-OPUS-4-8'],
    ['ALLOWED_MODELS', 'claude-haiku-5-5,claude-opus-5'],
  ])('refuses an Opus model in %s', (key, value) => {
    expect(() => parseConfig({ [key]: value })).toThrow(ConfigError);
    expect(() => parseConfig({ [key]: value })).toThrow(/Opus models are forbidden/);
  });

  it('refuses Opus pricing entries', () => {
    const pricing = JSON.stringify({
      'claude-haiku-5-5': {
        inputPerMTok: 1,
        outputPerMTok: 1,
        cacheWrite5mPerMTok: 1,
        cacheWrite1hPerMTok: 1,
        cacheReadPerMTok: 1,
      },
      'claude-sonnet-5-5': {
        inputPerMTok: 1,
        outputPerMTok: 1,
        cacheWrite5mPerMTok: 1,
        cacheWrite1hPerMTok: 1,
        cacheReadPerMTok: 1,
      },
      'claude-opus-5-5': {
        inputPerMTok: 1,
        outputPerMTok: 1,
        cacheWrite5mPerMTok: 1,
        cacheWrite1hPerMTok: 1,
        cacheReadPerMTok: 1,
      },
    });
    expect(() => parseConfig({ MODEL_PRICING_JSON: pricing })).toThrow(/Opus/);
  });

  it('requires MODEL_FAST to be in ALLOWED_MODELS', () => {
    expect(() =>
      parseConfig({ MODEL_FAST: 'claude-haiku-4-5', ALLOWED_MODELS: 'claude-sonnet-5-5' }),
    ).toThrow(/MODEL_FAST: must be listed in ALLOWED_MODELS/);
  });

  it('requires pricing for every allowed model', () => {
    expect(() =>
      parseConfig({ ALLOWED_MODELS: 'claude-haiku-5-5,claude-sonnet-5-5,example-model' }),
    ).toThrow(/has no pricing for allowed model example-model/);
  });

  it('names invalid variables without echoing their values', () => {
    const secretish = 'not-a-url-SECRET-VALUE-123';
    try {
      parseConfig({ DATABASE_URL: secretish, TRIAGE_PORT: 'abc', MODEL_PRICING_JSON: '{bad' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const e = error as ConfigError;
      expect(e.variables).toEqual(
        expect.arrayContaining(['DATABASE_URL', 'TRIAGE_PORT', 'MODEL_PRICING_JSON']),
      );
      expect(e.message).not.toContain(secretish);
      expect(e.message).not.toContain('{bad');
    }
  });

  it('rejects a warn threshold above the total cap', () => {
    expect(() => parseConfig({ TOTAL_BUDGET_USD: '40', TOTAL_BUDGET_WARN_USD: '50' })).toThrow(
      /TOTAL_BUDGET_WARN_USD/,
    );
  });
});

describe('requireSecret', () => {
  it('returns a set secret', () => {
    expect(requireSecret(parseConfig({ GITHUB_TOKEN: 'x' }), 'GITHUB_TOKEN')).toBe('x');
  });

  it('fails clearly on a missing secret', () => {
    expect(() => requireSecret(parseConfig({}), 'ANTHROPIC_API_KEY')).toThrow(
      /ANTHROPIC_API_KEY is not set/,
    );
  });
});

describe('assertModelAllowed', () => {
  const config = parseConfig({});
  it('accepts allowed models', () => {
    expect(() => assertModelAllowed(config, 'claude-haiku-5-5')).not.toThrow();
  });
  it('refuses Opus even if it were listed', () => {
    const forced = { ...config, ALLOWED_MODELS: [...config.ALLOWED_MODELS, 'claude-opus-5-5'] };
    expect(() => assertModelAllowed(forced, 'claude-opus-5-5')).toThrow(/forbidden/);
  });
  it('refuses models outside the allow-list', () => {
    expect(() => assertModelAllowed(config, 'claude-haiku-4-5')).toThrow(/not in ALLOWED_MODELS/);
  });
});
