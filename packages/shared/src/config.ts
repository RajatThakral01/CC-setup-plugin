import { z } from 'zod';

/** Any model ID containing this substring is refused, whatever the config says. */
export const FORBIDDEN_MODEL_PATTERN = /opus/i;

/** Per-million-token prices in USD for one model. */
export const modelPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheWrite5mPerMTok: z.number().nonnegative(),
  cacheWrite1hPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  /** Optional higher tier for prompts over `thresholdTokens` (Haiku 5.5 has one at 100K). */
  longContext: z
    .object({
      thresholdTokens: z.number().int().positive(),
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
      cacheWrite5mPerMTok: z.number().nonnegative(),
      cacheWrite1hPerMTok: z.number().nonnegative(),
      cacheReadPerMTok: z.number().nonnegative(),
    })
    .optional(),
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;

export const hostRateLimitSchema = z.object({
  /** Minimum milliseconds between two requests to this host. */
  minIntervalMs: z.number().int().nonnegative(),
});
export type HostRateLimit = z.infer<typeof hostRateLimitSchema>;

/**
 * Defaults verified 2026-10-19 against https://platform.claude.com/docs/en/about-claude/pricing
 * (see docs/DECISIONS.md). Override with MODEL_PRICING_JSON.
 */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheWrite5mPerMTok: 0.125,
    cacheWrite1hPerMTok: 0.2,
    cacheReadPerMTok: 0.01,
    longContext: {
      thresholdTokens: 100_000,
      inputPerMTok: 0.5,
      outputPerMTok: 2.5,
      cacheWrite5mPerMTok: 0.625,
      cacheWrite1hPerMTok: 1,
      cacheReadPerMTok: 0.05,
    },
  },
  'claude-sonnet-5-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheWrite5mPerMTok: 2.5,
    cacheWrite1hPerMTok: 4,
    cacheReadPerMTok: 0.1,
  },
};

export const DEFAULT_HOST_RATE_LIMITS: Record<string, HostRateLimit> = {
  'api.github.com': { minIntervalMs: 250 },
  'registry.npmjs.org': { minIntervalMs: 100 },
  'registry.modelcontextprotocol.io': { minIntervalMs: 200 },
  'raw.githubusercontent.com': { minIntervalMs: 100 },
};

/** Parses a JSON string env var against a schema; reports errors without echoing the value. */
function jsonString<T extends z.ZodType>(schema: T, fallback: z.input<T>) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): z.output<T> => {
      let parsed: unknown = fallback;
      if (raw !== undefined && raw.trim() !== '') {
        try {
          parsed = JSON.parse(raw);
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
          return z.NEVER;
        }
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({ code: 'custom', message: 'does not match the expected shape' });
        return z.NEVER;
      }
      return result.data;
    });
}

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

const modelId = z
  .string()
  .min(1)
  .refine((v) => !FORBIDDEN_MODEL_PATTERN.test(v), { message: 'Opus models are forbidden' });

const usd = z.coerce.number().nonnegative();

/** An official Docker Hub image (`node` or `python`) pinned by tag and sha256 digest. */
const officialImage = (name: 'node' | 'python') =>
  z
    .string()
    .regex(
      new RegExp(`^(docker\\.io/library/)?${name}:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$`),
      `must be the official ${name} image pinned as ${name}:<tag>@sha256:<digest>`,
    );

/** Python image tags like `3.13-slim-bookworm`: version must be 3.13+ (owner decision, M4). */
export function pythonAtLeast313(image: string): boolean {
  const m = /python:(\d+)\.(\d+)/.exec(image);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 3 || (major === 3 && minor >= 13);
}

export const SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'SNAPSHOT_SIGNING_KEY_PATH',
  'TRIAGE_ADMIN_TOKEN',
] as const;
export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];

export const configSchema = z
  .object({
    // Local default matches docker-compose.yml dev credentials; hosted deployments override it.
    DATABASE_URL: z.string().url().default('postgres://setup:setup@localhost:5433/setup_agent'),
    ANTHROPIC_API_KEY: optionalSecret,
    GITHUB_TOKEN: optionalSecret,
    MODEL_FAST: modelId.default('claude-haiku-5-5'),
    MODEL_STRONG: modelId.default('claude-sonnet-5-5'),
    ALLOWED_MODELS: z
      .string()
      .default('claude-haiku-5-5,claude-sonnet-5-5')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(z.array(modelId).min(1)),
    MODEL_PRICING_JSON: jsonString(z.record(z.string(), modelPricingSchema), DEFAULT_MODEL_PRICING),
    WEEKLY_BUDGET_USD: usd.default(20),
    BUDGET_SPLIT_CLASSIFY_USD: usd.default(3),
    TOTAL_BUDGET_USD: usd.default(40),
    TOTAL_BUDGET_WARN_USD: usd.default(30),
    SNAPSHOT_SIGNING_KEY_PATH: optionalSecret,
    SNAPSHOT_STORE: z.enum(['github-release', 'local']).default('local'),
    /** Where the local snapshot store writes files (relative paths resolve from the working directory). */
    SNAPSHOT_LOCAL_DIR: z.string().min(1).default('.snapshots'),
    /** Weekly policy digests and scheduled eval plans (PRD FR-P7, FR-P8). */
    REPORTS_DIR: z.string().min(1).default('reports'),
    /** Daily approval-policy run (after the gates at GATES_CRON). */
    POLICY_CRON: z.string().default('0 5 * * *'),
    /** Weekly digest (Mondays, after the scheduled evals). */
    DIGEST_CRON: z.string().default('0 9 * * 1'),
    SNAPSHOT_REPO: z.string().optional(),
    TRIAGE_HOST: z.string().default('127.0.0.1'),
    TRIAGE_PORT: z.coerce.number().int().min(1).max(65535).default(4400),
    TRIAGE_ADMIN_TOKEN: optionalSecret,
    EVAL_MAX_TURNS: z.coerce.number().int().positive().default(15),
    EVAL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
    // Eval harness (plan M9). Claude Code version baked into the eval image and pinned per run.
    EVAL_CLAUDE_CODE_VERSION: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default('2.1.303'),
    /** Unset: Docker's native platform for the host. Recorded with every run's artifacts. */
    EVAL_PLATFORM: z.enum(['linux/amd64', 'linux/arm64']).optional(),
    EVAL_ARTIFACT_DIR: z.string().min(1).default('.artifacts/evals'),
    /** Hard cap per run (`claude --max-budget-usd`); also the cost estimate before any run is measured. */
    EVAL_RUN_MAX_USD: usd.default(1.5),
    EVAL_SCREEN_RUNS: z.coerce.number().int().min(1).max(10).default(3),
    /** Stage A success-rate lead over the baseline needed before a Stage B confirmation. */
    EVAL_CONFIRM_THRESHOLD: z.coerce.number().min(0).max(1).default(0.2),
    /** Stop a candidate's Stage A after it fails this many tasks the baseline passed. */
    EVAL_EARLY_STOP_FAILS: z.coerce.number().int().min(1).default(2),
    EVAL_SETUP_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
    EVAL_CHECK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
    EVAL_CPUS: z.coerce.number().positive().max(8).default(2),
    EVAL_MEMORY_MB: z.coerce.number().int().min(512).max(16384).default(4096),
    EVAL_PIDS_LIMIT: z.coerce.number().int().min(64).max(8192).default(2048),
    /** Hosts the eval container may reach through the egress proxy (besides the Anthropic API relay). */
    EVAL_EGRESS_ALLOWLIST: z
      .string()
      .default('registry.npmjs.org')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    /** Upstream for the API relay; the eval container never holds the real API key. */
    EVAL_ANTHROPIC_API_URL: z.url().default('https://api.anthropic.com'),
    HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(4),
    HTTP_BASE_DELAY_MS: z.coerce.number().int().positive().default(500),
    HTTP_MAX_DELAY_MS: z.coerce.number().int().positive().default(60_000),
    HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    HTTP_HOST_RATE_LIMITS_JSON: jsonString(
      z.record(z.string(), hostRateLimitSchema),
      DEFAULT_HOST_RATE_LIMITS,
    ),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // External endpoints (portability: every host comes from config).
    GITHUB_API_URL: z.url().default('https://api.github.com'),
    GITHUB_RAW_URL: z.url().default('https://raw.githubusercontent.com'),
    NPM_REGISTRY_URL: z.url().default('https://registry.npmjs.org'),
    MCP_REGISTRY_URL: z.url().default('https://registry.modelcontextprotocol.io/v0.1'),
    CLAUDE_CODE_REPO: z.string().default('anthropics/claude-code'),
    // Discovery (plan M3) and intake filter (PRD FR-D10).
    DISCOVERY_CRON: z.string().default('0 2 * * *'),
    DISCOVERY_LOOKBACK_DAYS: z.coerce.number().int().positive().default(7),
    GITHUB_SEARCH_TOPICS: z
      .string()
      .default('mcp-server,claude-code,claude-skills,claude-code-plugin')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    GITHUB_SEARCH_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
    GITHUB_SEARCH_MAX_PAGES: z.coerce.number().int().min(1).max(10).default(10),
    GITHUB_SEARCH_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2500),
    REGISTRY_MAX_PAGES: z.coerce.number().int().positive().default(200),
    CHANGELOG_MAX_VERSIONS: z.coerce.number().int().positive().default(30),
    INTAKE_MIN_STARS: z.coerce.number().int().nonnegative().default(10),
    INTAKE_DAILY_CAP: z.coerce.number().int().nonnegative().default(30),
    INTAKE_REFRESH_LIMIT: z.coerce.number().int().nonnegative().default(200),
    CLASSIFY_README_CHARS: z.coerce.number().int().positive().default(4000),
    CLASSIFY_MAX_TOKENS: z.coerce.number().int().positive().default(600),
    /** Filter-passing raw records classified per UTC day before ranking (owner decision). */
    CLASSIFY_DAILY_RECORD_LIMIT: z.coerce.number().int().nonnegative().default(300),
    // Credibility gates (plan M4). Sandbox images: official node/python only, tag plus digest.
    GATE_NODE_IMAGE: officialImage('node').default(
      'node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392',
    ),
    GATE_PYTHON_IMAGE: officialImage('python')
      .refine((v) => pythonAtLeast313(v), {
        message:
          'must be Python 3.13 or newer (some MCP servers need it); use the pinned python:3.13-slim-bookworm image',
      })
      .default(
        'python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641',
      ),
    GATE_INSTALL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
    GATE_LIST_TOOLS_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
    GATE_CPUS: z.coerce.number().positive().max(4).default(1),
    GATE_MEMORY_MB: z.coerce.number().int().min(128).max(4096).default(1024),
    GATE_PIDS_LIMIT: z.coerce.number().int().min(16).max(1024).default(256),
    /** Fixed sandbox platform so results don't depend on the host CPU (emulated on Apple Silicon). */
    GATE_PLATFORM: z.enum(['linux/amd64', 'linux/arm64']).default('linux/amd64'),
    GATE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
    GATE_RECHECK_DAYS: z.coerce.number().int().positive().default(30),
    GATES_CRON: z.string().default('0 4 * * *'),
    OSV_API_URL: z.url().default('https://api.osv.dev/v1'),
    NPM_DOWNLOADS_URL: z.url().default('https://api.npmjs.org'),
    PYPI_URL: z.url().default('https://pypi.org'),
  })
  .superRefine((c, ctx) => {
    for (const key of ['MODEL_FAST', 'MODEL_STRONG'] as const) {
      if (!c.ALLOWED_MODELS.includes(c[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must be listed in ALLOWED_MODELS' });
      }
    }
    for (const model of c.ALLOWED_MODELS) {
      if (!(model in c.MODEL_PRICING_JSON)) {
        ctx.addIssue({
          code: 'custom',
          path: ['MODEL_PRICING_JSON'],
          message: `has no pricing for allowed model ${model}`,
        });
      }
    }
    if (Object.keys(c.MODEL_PRICING_JSON).some((m) => FORBIDDEN_MODEL_PATTERN.test(m))) {
      ctx.addIssue({
        code: 'custom',
        path: ['MODEL_PRICING_JSON'],
        message: 'Opus models are forbidden',
      });
    }
    if (c.BUDGET_SPLIT_CLASSIFY_USD > c.WEEKLY_BUDGET_USD) {
      ctx.addIssue({
        code: 'custom',
        path: ['BUDGET_SPLIT_CLASSIFY_USD'],
        message: 'cannot exceed WEEKLY_BUDGET_USD',
      });
    }
    if (c.TOTAL_BUDGET_WARN_USD > c.TOTAL_BUDGET_USD) {
      ctx.addIssue({
        code: 'custom',
        path: ['TOTAL_BUDGET_WARN_USD'],
        message: 'cannot exceed TOTAL_BUDGET_USD',
      });
    }
  });

export type AppConfig = z.output<typeof configSchema>;
