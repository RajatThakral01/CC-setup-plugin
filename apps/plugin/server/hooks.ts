import type { HookId, HookProposal, ProjectProfile } from '@cc-setup-agent/shared';
import { PluginError } from './files.js';

/**
 * Hook recipes (plan M7 "hook recipes from templates"), built from the detected project tooling.
 *
 * Each hook is a self-contained `node -e` command (Node is always present in a Next.js project, so
 * no jq or shell scripts are needed) that reads the hook input JSON from stdin, as documented for
 * Claude Code hooks (verified 2026-10-19, Claude Code 2.1.303): `tool_input.file_path` for Edit and
 * Write, `stop_hook_active` on Stop, `CLAUDE_PROJECT_DIR` in the environment, exit 2 feeds stderr
 * back to Claude. The trailing `# setup-agent:<id>` comment marks hooks we added, so a second run
 * never adds them twice.
 */
export type HookRecipe = HookProposal & {
  event: 'PostToolUse' | 'Stop';
  matcher?: string;
  command: string;
  timeout: number;
};

const MARKER = '# setup-agent:';
const EDIT_MATCHER = 'Edit|Write';

/** How to run a locally installed binary, per package manager (never downloads anything). */
function execPrefix(pm: ProjectProfile['packageManager']): string[] {
  if (pm === 'pnpm') return ['pnpm', 'exec'];
  if (pm === 'yarn') return ['yarn'];
  if (pm === 'bun') return ['bunx', '--no-install'];
  return ['npx', '--no-install'];
}

function runScript(pm: ProjectProfile['packageManager'], script: string): string[] {
  return pm === 'yarn' ? ['yarn', script] : [pm ?? 'npm', 'run', script];
}

const READ_INPUT = 'const i=JSON.parse(require("fs").readFileSync(0,"utf8"));';
const SPAWN = 'require("child_process").spawnSync';
const CWD = 'cwd:process.env.CLAUDE_PROJECT_DIR||"."';
const FAIL = 'process.stderr.write(((r.stdout||"")+(r.stderr||"")).slice(-4000));process.exit(2)';

function nodeCommand(js: string, id: string): string {
  if (js.includes("'")) throw new PluginError(`hook ${id}: script must not contain single quotes`);
  return `node -e '${js}' ${MARKER}${id}`;
}

/** Runs the tool on the edited file; when `report` is set, exit code 1 is fed back to Claude. */
function onEditedFile(argv: string[], exts: string, id: string, report: boolean): string {
  const call = `${SPAWN}(${JSON.stringify(argv[0])},${JSON.stringify(argv.slice(1))}.concat([f]),`;
  const body = report
    ? `const r=${call}{encoding:"utf8",${CWD}});if(r.status===1){${FAIL}}`
    : `${call}{stdio:"ignore",${CWD}});`;
  return nodeCommand(
    `${READ_INPUT}const f=i.tool_input&&i.tool_input.file_path;if(f&&/\\.(${exts})$/i.test(f)){${body}}`,
    id,
  );
}

const PRETTIER_EXTS = 'js|jsx|ts|tsx|mjs|cjs|mts|cts|json|css|scss|md|mdx|html|yaml|yml';
const BIOME_EXTS = 'js|jsx|ts|tsx|mjs|cjs|mts|cts|json|jsonc|css';
const LINT_EXTS = 'js|jsx|ts|tsx|mjs|cjs|mts|cts';

/** Hook recipes that fit the project; empty when it has no formatter, linter or TypeScript. */
export function hookRecipes(profile: ProjectProfile): HookRecipe[] {
  const { formatter, linter, scripts } = profile.tooling;
  const exec = execPrefix(profile.packageManager);
  const recipes: HookRecipe[] = [];
  if (formatter) {
    const argv =
      formatter === 'prettier'
        ? [...exec, 'prettier', '--write', '--log-level', 'silent']
        : [...exec, 'biome', 'format', '--write'];
    recipes.push({
      id: 'format-on-edit',
      event: 'PostToolUse',
      matcher: EDIT_MATCHER,
      description: `Formats each file Claude edits or writes with ${formatter}.`,
      reason: `Detected ${formatter}.`,
      command: onEditedFile(
        argv,
        formatter === 'prettier' ? PRETTIER_EXTS : BIOME_EXTS,
        'format-on-edit',
        false,
      ),
      timeout: 30,
    });
  }
  if (linter) {
    const argv =
      linter === 'eslint' ? [...exec, 'eslint', '--no-warn-ignored'] : [...exec, 'biome', 'lint'];
    recipes.push({
      id: 'lint-on-edit',
      event: 'PostToolUse',
      matcher: EDIT_MATCHER,
      description: `Lints each edited file with ${linter} and shows errors to Claude so it fixes them.`,
      reason: `Detected ${linter}.`,
      command: onEditedFile(argv, LINT_EXTS, 'lint-on-edit', true),
      timeout: 60,
    });
  }
  const typecheckScript = scripts.find((s) => s === 'typecheck' || s === 'type-check');
  if (typecheckScript || profile.typescript) {
    const argv = typecheckScript
      ? runScript(profile.packageManager, typecheckScript)
      : [...exec, 'tsc', '--noEmit'];
    recipes.push({
      id: 'typecheck-on-stop',
      event: 'Stop',
      description:
        'Type-checks the project when Claude finishes a turn; type errors are sent back so Claude fixes them before stopping. Adds a few seconds to every turn.',
      reason: typecheckScript
        ? `Found the "${typecheckScript}" script.`
        : 'TypeScript project (runs tsc --noEmit).',
      command: nodeCommand(
        `${READ_INPUT}if(!i.stop_hook_active){const r=${SPAWN}(${JSON.stringify(argv[0])},${JSON.stringify(argv.slice(1))},{encoding:"utf8",${CWD}});if(r.status!==0&&r.status!==null){${FAIL}}}`,
        'typecheck-on-stop',
      ),
      timeout: 300,
    });
  }
  return recipes;
}

/** Proposal shown to the user (no command internals beyond what the diff will show). */
export function hookProposals(profile: ProjectProfile): HookProposal[] {
  return hookRecipes(profile).map(({ id, description, reason }) => ({ id, description, reason }));
}

/** Tool name each recipe runs, used to spot an existing hook that already does the same job. */
const TOOL_WORDS: Record<string, RegExp> = {
  'format-on-edit': /\b(prettier|biome)\b/,
  'lint-on-edit': /\b(eslint|biome)\b/,
  'typecheck-on-stop': /\b(tsc|typecheck|type-check)\b/,
};

function existingCommands(groups: unknown): string[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g: unknown) => {
    const hooks = g && typeof g === 'object' ? (g as { hooks?: unknown }).hooks : undefined;
    return Array.isArray(hooks)
      ? hooks.flatMap((h: unknown) => {
          const c = h && typeof h === 'object' ? (h as { command?: unknown }).command : undefined;
          return typeof c === 'string' ? [c] : [];
        })
      : [];
  });
}

export interface HookMergeResult {
  hooks: Record<string, unknown>;
  added: HookId[];
  skipped: Array<{ id: HookId; reason: string }>;
}

/**
 * Adds approved recipes to the settings `hooks` object. Existing hooks are never changed or
 * removed: new matcher groups are appended, and a recipe is skipped when it's already there or an
 * existing hook on the same event already runs the same tool.
 */
export function mergeHooks(existing: unknown, recipes: HookRecipe[]): HookMergeResult {
  if (
    existing !== undefined &&
    (existing === null || typeof existing !== 'object' || Array.isArray(existing))
  )
    throw new PluginError(
      '.claude/settings.json "hooks" is not an object; fix it before adding hooks',
    );
  const hooks: Record<string, unknown> = { ...((existing as Record<string, unknown>) ?? {}) };
  const added: HookId[] = [];
  const skipped: HookMergeResult['skipped'] = [];
  for (const r of recipes) {
    const current = hooks[r.event];
    if (current !== undefined && !Array.isArray(current)) {
      skipped.push({
        id: r.id,
        reason: `existing "${r.event}" hooks are not a list; left untouched`,
      });
      continue;
    }
    const commands = existingCommands(current);
    if (commands.some((c) => c.includes(`${MARKER}${r.id}`))) {
      skipped.push({ id: r.id, reason: 'already installed' });
      continue;
    }
    const same = commands.find((c) => TOOL_WORDS[r.id]?.test(c));
    if (same) {
      skipped.push({ id: r.id, reason: `an existing ${r.event} hook already does this` });
      continue;
    }
    const group = {
      ...(r.matcher ? { matcher: r.matcher } : {}),
      hooks: [{ type: 'command', command: r.command, timeout: r.timeout }],
    };
    hooks[r.event] = [...((current as unknown[] | undefined) ?? []), group];
    added.push(r.id);
  }
  return { hooks, added, skipped };
}
