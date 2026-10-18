import type { Capability, SecurityFinding } from '@cc-setup-agent/shared';
import type { EgressEvent, ToolDefinition } from './sandbox/probe.js';

/** A security finding; `confirmed` findings block the item outright (PRD FR-C3). */
export interface Finding extends SecurityFinding {
  rule: string;
  confirmed: boolean;
}

/** Instructions aimed at the model rather than describing the tool. High confidence → confirmed. */
const INJECTION_PATTERNS: Array<[string, RegExp]> = [
  [
    'ignore_instructions',
    /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all|other)\b[^.]{0,20}\b(instructions?|prompts?|rules)\b/i,
  ],
  [
    'hide_from_user',
    /\b(do not|don't|never)\b[^.]{0,30}\b(tell|inform|mention|reveal|show)\b[^.]{0,30}\b(the )?user\b/i,
  ],
  [
    'override_system',
    /\b(system prompt|developer message)\b[^.]{0,40}\b(override|replace|ignore)\b|\byou are now\b/i,
  ],
];

/** Pseudo-tags used to smuggle instructions into descriptions. */
const INSTRUCTION_TAG = /<\s*\/?\s*(important|system|instructions?|secret|hidden)\s*>/i;

const SENSITIVE_PATH =
  /(~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc|\.netrc|\.env\b|\.git-credentials|mcp\.json|claude_desktop_config|\.cursor\/|keychain|wallet\.dat)/i;
const READ_OR_SEND =
  /\b(reads?|reading|cat|opens?|load(s|ing)?|includes?|send(s|ing)?|posts?|uploads?|forward(s|ing)?|pass(es|ing)?|exfiltrat\w*|transmit(s|ting)?)\b/i;
const EXFIL_TO_URL =
  /\b(send(s|ing)?|posts?|upload(s|ing)?|forward(s|ing)?|transmit(s|ting)?|exfiltrat\w*)\b[^.]{0,60}(https?:\/\/|\bwebhook\b|\bendpoint\b|\bserver\b)/i;

/** Invisible or direction-changing characters (zero-width, bidi controls, BOM). */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
/** Unicode tag characters (U+E0000–E007F) can spell hidden ASCII text. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/u;

export const LONG_DESCRIPTION_CHARS = 1000;

/** Every free-text string in a tool definition: name, description and nested schema descriptions. */
export function toolTexts(tool: ToolDefinition): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [
    { where: `${tool.name}.name`, text: tool.name },
  ];
  if (tool.description) out.push({ where: `${tool.name}.description`, text: tool.description });
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if ((k === 'description' || k === 'title') && typeof v === 'string')
          out.push({ where: `${path}.${k}`, text: v });
        else walk(v, `${path}.${k}`);
      }
    }
  };
  walk(tool.inputSchema, `${tool.name}.inputSchema`);
  return out;
}

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

/** Scans one piece of untrusted text (tool description, SKILL.md …) for hidden instructions. */
export function scanText(
  where: string,
  text: string,
  options: { checkLength?: boolean } = {},
): Finding[] {
  const findings: Finding[] = [];
  for (const [rule, re] of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m)
      findings.push({
        rule,
        severity: 'critical',
        confirmed: true,
        description: `Instruction aimed at the model in ${where}`,
        evidence: clip(m[0]),
      });
  }
  if (TAG_CHARS.test(text)) {
    const hidden = [...text]
      .filter((c) => TAG_CHARS.test(c))
      .map((c) => String.fromCharCode(c.codePointAt(0)! - 0xe0000))
      .join('');
    findings.push({
      rule: 'unicode_tag_chars',
      severity: 'critical',
      confirmed: true,
      description: `Hidden Unicode tag characters in ${where}`,
      evidence: clip(hidden),
    });
  }
  if (INVISIBLE.test(text)) {
    findings.push({
      rule: 'invisible_unicode',
      severity: 'high',
      confirmed: false,
      description: `Invisible or bidi-control characters in ${where}`,
    });
  }
  if (INSTRUCTION_TAG.test(text)) {
    findings.push({
      rule: 'instruction_tag',
      severity: 'high',
      confirmed: false,
      description: `Instruction-style tag in ${where}`,
      evidence: clip(INSTRUCTION_TAG.exec(text)![0]),
    });
  }
  const sensitive = SENSITIVE_PATH.exec(text);
  if (sensitive && READ_OR_SEND.test(text)) {
    findings.push({
      rule: 'sensitive_file',
      severity: 'high',
      confirmed: false,
      description: `References a sensitive file in ${where}`,
      evidence: clip(sensitive[0]),
    });
  }
  const exfil = EXFIL_TO_URL.exec(text);
  if (exfil)
    findings.push({
      rule: 'exfiltration_language',
      severity: 'medium',
      confirmed: false,
      description: `Asks to send data somewhere in ${where}`,
      evidence: clip(exfil[0]),
    });
  if (options.checkLength && text.length > LONG_DESCRIPTION_CHARS) {
    findings.push({
      rule: 'long_description',
      severity: 'low',
      confirmed: false,
      description: `${where} is ${text.length} characters long`,
    });
  }
  return findings;
}

export function scanToolDefinitions(tools: ToolDefinition[]): Finding[] {
  return tools.flatMap((tool) =>
    toolTexts(tool).flatMap(({ where, text }) =>
      scanText(where, text, { checkLength: where.endsWith('.description') }),
    ),
  );
}

const CAPABILITY_PATTERNS: Array<[Capability, RegExp]> = [
  [
    'shell',
    /\b(shell|bash|terminal|exec(ute)?_?(command|cmd)?|run_?(command|script)|subprocess|spawn)\b/i,
  ],
  [
    'file_read',
    /\b(read_?file|read|list_?(dir|directory|files)|get_?file|cat|glob|search_?files)\b/i,
  ],
  [
    'file_write',
    /\b(write_?file|write|edit_?file|create_?file|delete_?file|move_?file|rename|patch)\b/i,
  ],
  ['network', /\b(fetch|http|url|request|download|web|api|webhook|crawl|scrape)\b/i],
  ['browser', /\b(browser|navigate|click|screenshot|page|tab|dom|playwright|puppeteer)\b/i],
  ['database', /\b(sql|query|database|table|postgres|mysql|mongo|redis|sqlite|schema)\b/i],
  ['code_execution', /\b(eval|execute_?code|run_?code|python|javascript|sandbox|notebook)\b/i],
];

/** Capabilities inferred from tool names and descriptions, plus a hint from the item kind. */
export function inferCapabilities(tools: ToolDefinition[], kind: string | null): Capability[] {
  const caps = new Set<Capability>();
  const text = tools
    .map((t) => `${t.name.replace(/[_-]/g, ' ')} ${t.name} ${t.description ?? ''}`)
    .join('\n');
  for (const [cap, re] of CAPABILITY_PATTERNS) if (re.test(text)) caps.add(cap);
  if (kind === 'hook_recipe') caps.add('shell');
  return [...caps].sort();
}

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

export function installScriptFindings(
  scripts: Record<string, string> | undefined,
  where: string,
): Finding[] {
  return INSTALL_SCRIPTS.filter((s) => scripts?.[s]).map((s) => ({
    rule: 'install_script',
    severity: 'medium' as const,
    confirmed: false,
    description: `${where} runs a "${s}" script on install`,
    evidence: clip(scripts![s]!),
  }));
}

/** Hosts a sandboxed install legitimately talks to. */
export const INSTALL_HOSTS = new Set([
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
]);

/**
 * Connections the server made after start-up, while only listing its tools. Contacting anything
 * at that point is unexpected; reported for review, never auto-blocked (could be a licence check).
 */
export function egressFindings(egress: EgressEvent[]): Finding[] {
  const runtime = [
    ...new Set(egress.filter((e) => e.phase === 'runtime').map((e) => `${e.host}:${e.port}`)),
  ];
  const unexpectedInstall = [
    ...new Set(
      egress.filter((e) => e.phase === 'install' && !INSTALL_HOSTS.has(e.host)).map((e) => e.host),
    ),
  ];
  const findings: Finding[] = [];
  if (runtime.length > 0) {
    findings.push({
      rule: 'runtime_egress',
      severity: 'high',
      confirmed: false,
      description: 'Contacted network hosts while listing tools',
      evidence: runtime.join(', '),
    });
  }
  if (unexpectedInstall.length > 0) {
    findings.push({
      rule: 'install_egress',
      severity: 'low',
      confirmed: false,
      description: 'Contacted non-registry hosts during install',
      evidence: unexpectedInstall.join(', '),
    });
  }
  return findings;
}

/** Serialised tool definitions at ~4 characters per token (plan M4: no API call). */
export function contextOverheadTokens(tools: ToolDefinition[]): number {
  return Math.ceil(JSON.stringify(tools).length / 4);
}
