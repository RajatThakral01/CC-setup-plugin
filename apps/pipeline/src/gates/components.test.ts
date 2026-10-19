import { describe, expect, it } from 'vitest';
import {
  componentPaths,
  estimateComponents,
  firstPublished,
  LISTING_DESCRIPTION_CHARS,
  parseFrontmatter,
} from './components.js';

const skill = (name: string, description: string, body: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`;

describe('parseFrontmatter', () => {
  it('reads simple, quoted and folded fields', () => {
    const { fields, body } = parseFrontmatter(
      `---\nname: "example-skill"\ndescription: >\n  Builds things\n  on a platform.\nlicense: MIT\n---\n# Body\n`,
    );
    expect(fields).toEqual({
      name: 'example-skill',
      description: 'Builds things on a platform.',
      license: 'MIT',
    });
    expect(body).toBe('# Body\n');
    expect(parseFrontmatter('# no frontmatter').fields).toEqual({});
  });
});

describe('componentPaths', () => {
  it('finds skills, commands and agents', () => {
    expect(
      componentPaths([
        'README.md',
        'skills/deploy/SKILL.md',
        'plugins/x/commands/access.md',
        'agents/reviewer.md',
        'skills/deploy/reference.md',
      ]),
    ).toEqual([
      { type: 'agents', path: 'agents/reviewer.md' },
      { type: 'commands', path: 'plugins/x/commands/access.md' },
      { type: 'skills', path: 'skills/deploy/SKILL.md' },
    ]);
  });
});

describe('estimateComponents', () => {
  it('counts listed descriptions every turn and the largest body on use', () => {
    const files = [
      {
        type: 'skills' as const,
        path: 'skills/a/SKILL.md',
        text: skill('a', 'x'.repeat(396), 'b'.repeat(8000)),
      },
      {
        type: 'commands' as const,
        path: 'commands/c.md',
        text: skill('c', 'y'.repeat(96), 'z'.repeat(400)),
      },
      {
        type: 'skills' as const,
        path: 'skills/manual/SKILL.md',
        text: skill('manual', 'w'.repeat(400), 'v'.repeat(40), 'disable-model-invocation: true\n'),
      },
    ];
    const r = estimateComponents(files, [], 0);
    // a: (1 + 396) / 4 → 100 + 8; c: (1 + 96) / 4 → 25 + 8; manual is not listed.
    expect(r.alwaysTokens).toBe(108 + 33);
    expect(r.onUseTokens).toBe(2000);
    expect(r.components.skills.map((s) => s.name)).toEqual(['a', 'manual']);
    expect(r.components.commands).toEqual([{ name: 'c', description: 'y'.repeat(96) }]);
  });

  it('caps a description at the listing limit and lists MCP tools', () => {
    const long = estimateComponents(
      [{ type: 'skills', path: 'SKILL.md', text: skill('n', 'd'.repeat(5000), '') }],
      [],
      0,
    );
    expect(long.alwaysTokens).toBe(Math.ceil((1 + LISTING_DESCRIPTION_CHARS) / 4) + 8);
    const tools = estimateComponents([], [{ name: 'send', description: 'Send a message' }], 2);
    expect(tools.components.tools).toEqual([{ name: 'send', description: 'Send a message' }]);
    expect(tools.components.mcpServers).toBe(2);
    expect(estimateComponents([], [], 0).alwaysTokens).toBeNull();
  });
});

describe('firstPublished', () => {
  it('takes the earliest valid date', () => {
    expect(
      firstPublished('2025-03-01T00:00:00Z', undefined, 'bad', '2024-01-01T00:00:00Z'),
    ).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(firstPublished(null, undefined)).toBeNull();
  });
});
