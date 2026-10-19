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
export interface HookGroup {
  event: 'PostToolUse' | 'Stop';
  matcher?: string;
  command: string;
  timeout: number;
}
/** One approval can add several hook groups (lint-on-edit: after each edit, and at Stop). */
export type HookRecipe = HookProposal & { groups: HookGroup[] };

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

/**
 * Runs the tool on the edited file. With `lint`, exit code 1 (errors) is fed back to Claude as a
 * blocking error (exit 2), and warnings (exit 0 with diagnostics, matched by `lint.warnings`) as
 * non-blocking `additionalContext` (PostToolUse JSON output, code.claude.com/docs/en/hooks).
 */
function onEditedFile(
  argv: string[],
  exts: string,
  id: string,
  lint?: { warnings: string },
): string {
  const call = `${SPAWN}(${JSON.stringify(argv[0])},${JSON.stringify(argv.slice(1))}.concat([f]),`;
  const warn =
    'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",' +
    'additionalContext:"Lint warnings in "+f+" (not blocking; fix those your change caused):\\n"+o.slice(-4000)}}))';
  const body = lint
    ? `const r=${call}{encoding:"utf8",${CWD}});const o=((r.stdout||"")+(r.stderr||"")).trim();if(r.status===1){${FAIL}}else if(r.status===0&&${lint.warnings}){${warn}}`
    : `${call}{stdio:"ignore",${CWD}});`;
  return nodeCommand(
    `${READ_INPUT}const f=i.tool_input&&i.tool_input.file_path;if(f&&/\\.(${exts})$/i.test(f)){${body}}`,
    id,
  );
}

/**
 * Stop-hook lint over files changed in the working tree (staged, modified or untracked, from git),
 * so edits made through Bash (sed, scripts) are linted too. Only errors are fed back (exit 2,
 * Claude continues and fixes them); warnings are left out here, because feeding them back at every
 * Stop would force an extra turn for warnings the user may have accepted. Skipped outside git and
 * when `stop_hook_active` is set. At most 50 files.
 */
function onChangedFiles(argv: string[], exts: string, id: string): string {
  return nodeCommand(
    `${READ_INPUT}if(!i.stop_hook_active){const cp=require("child_process"),fs=require("fs"),p=require("path");` +
      `const d=process.env.CLAUDE_PROJECT_DIR||".";` +
      `const g=a=>{const r=cp.spawnSync("git",a,{encoding:"utf8",cwd:d});return r.status===0?r.stdout.split("\\n"):[]};` +
      `const files=[...new Set(g(["diff","--name-only","--cached","--relative"]).concat(g(["ls-files","-m","-o","--exclude-standard"])))]` +
      `.filter(f=>f&&/\\.(${exts})$/i.test(f)&&fs.existsSync(p.join(d,f))).slice(0,50);` +
      `if(files.length){const r=cp.spawnSync(${JSON.stringify(argv[0])},${JSON.stringify(argv.slice(1))}.concat(files),{encoding:"utf8",cwd:d});if(r.status===1){${FAIL}}}}`,
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
      description: `Formats each file Claude edits or writes with ${formatter}.`,
      reason: `Detected ${formatter}.`,
      groups: [
        {
          event: 'PostToolUse',
          matcher: EDIT_MATCHER,
          command: onEditedFile(
            argv,
            formatter === 'prettier' ? PRETTIER_EXTS : BIOME_EXTS,
            'format-on-edit',
          ),
          timeout: 30,
        },
      ],
    });
  }
  if (linter) {
    const argv =
      linter === 'eslint' ? [...exec, 'eslint', '--no-warn-ignored'] : [...exec, 'biome', 'lint'];
    // ESLint's default formatter prints nothing for a clean file; Biome always prints a summary,
    // so its warnings are recognised by their rule names (lint/<group>/<rule>).
    const warnings = linter === 'eslint' ? 'o!==""' : '/lint\\/[a-z]/i.test(o)';
    recipes.push({
      id: 'lint-on-edit',
      description: `Lints each file Claude edits with ${linter}: errors are sent back as blocking feedback, warnings as non-blocking notes. When Claude finishes a turn, files changed in git (including edits made through shell commands) are linted again and errors sent back.`,
      reason: `Detected ${linter}.`,
      groups: [
        {
          event: 'PostToolUse',
          matcher: EDIT_MATCHER,
          command: onEditedFile(argv, LINT_EXTS, 'lint-on-edit', { warnings }),
          timeout: 60,
        },
        { event: 'Stop', command: onChangedFiles(argv, LINT_EXTS, 'lint-on-edit'), timeout: 120 },
      ],
    });
  }
  const typecheckScript = scripts.find((s) => s === 'typecheck' || s === 'type-check');
  if (typecheckScript || profile.typescript) {
    const argv = typecheckScript
      ? runScript(profile.packageManager, typecheckScript)
      : [...exec, 'tsc', '--noEmit'];
    recipes.push({
      id: 'typecheck-on-stop',
      description:
        'Type-checks the project when Claude finishes a turn; type errors are sent back so Claude fixes them before stopping. Adds a few seconds to every turn.',
      reason: typecheckScript
        ? `Found the "${typecheckScript}" script.`
        : 'TypeScript project (runs tsc --noEmit).',
      groups: [
        {
          event: 'Stop',
          command: nodeCommand(
            `${READ_INPUT}if(!i.stop_hook_active){const r=${SPAWN}(${JSON.stringify(argv[0])},${JSON.stringify(argv.slice(1))},{encoding:"utf8",${CWD}});if(r.status!==0&&r.status!==null){${FAIL}}}`,
            'typecheck-on-stop',
          ),
          timeout: 300,
        },
      ],
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
    // A recipe is added whole or not at all, so check every group's event first.
    let skip: string | null = null;
    for (const g of r.groups) {
      const current = hooks[g.event];
      if (current !== undefined && !Array.isArray(current)) {
        skip = `existing "${g.event}" hooks are not a list; left untouched`;
        break;
      }
      const commands = existingCommands(current);
      if (commands.some((c) => c.includes(`${MARKER}${r.id}`))) {
        skip = 'already installed';
        break;
      }
      // Only our own marker is exempt: e.g. our typecheck hook doesn't count as a lint hook.
      const same = commands.find((c) =>
        TOOL_WORDS[r.id]?.test(c.replace(/# setup-agent:\S+/g, '')),
      );
      if (same) {
        skip = `an existing ${g.event} hook already does this`;
        break;
      }
    }
    if (skip) {
      skipped.push({ id: r.id, reason: skip });
      continue;
    }
    for (const g of r.groups) {
      const group = {
        ...(g.matcher ? { matcher: g.matcher } : {}),
        hooks: [{ type: 'command', command: g.command, timeout: g.timeout }],
      };
      hooks[g.event] = [...((hooks[g.event] as unknown[] | undefined) ?? []), group];
    }
    added.push(r.id);
  }
  return { hooks, added, skipped };
}
