/**
 * Shows the latest GitHub Actions runs for the repo (and failed-step logs with --logs).
 *   pnpm ci:status [--sha <commit>] [--logs]
 * Uses GITHUB_TOKEN from .env for rate limits; the token is never printed.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  createHttpClientFromConfig,
  HttpError,
  loadConfig,
  requireSecret,
} from '@cc-setup-agent/core';

const { values } = parseArgs({ options: { sha: { type: 'string' }, logs: { type: 'boolean' } } });
const config = loadConfig();
const http = createHttpClientFromConfig(config);
const headers = {
  authorization: `Bearer ${requireSecret(config, 'GITHUB_TOKEN')}`,
  'user-agent': 'cc-setup-agent',
};

const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(remote)?.[1];
if (!repo) throw new Error('origin is not a GitHub remote');
const sha = values.sha ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const api = `${config.GITHUB_API_URL}/repos/${repo}`;

function noAccess(error: unknown): never {
  if (error instanceof HttpError && (error.status === 404 || error.status === 403)) {
    console.error(
      `Cannot read GitHub Actions for ${repo} (HTTP ${error.status}). The repo is probably private and GITHUB_TOKEN ` +
        'has no access to it. Give the token "Actions: read" on this repo, or check the run on github.com.',
    );
    process.exit(2);
  }
  throw error;
}

const runs = await http
  .getJson(
    `${api}/actions/runs?head_sha=${sha}`,
    z.object({
      workflow_runs: z.array(
        z.looseObject({
          id: z.number(),
          name: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
          html_url: z.string(),
        }),
      ),
    }),
    { headers },
  )
  .catch(noAccess);
if (runs.workflow_runs.length === 0) console.log(`No runs yet for ${sha.slice(0, 7)}`);
for (const run of runs.workflow_runs) {
  console.log(`${run.name}: ${run.status} ${run.conclusion ?? ''}  ${run.html_url}`);
  const jobs = await http.getJson(
    `${api}/actions/runs/${run.id}/jobs`,
    z.object({
      jobs: z.array(
        z.looseObject({
          id: z.number(),
          name: z.string(),
          conclusion: z.string().nullable(),
          steps: z
            .array(z.looseObject({ name: z.string(), conclusion: z.string().nullable() }))
            .optional(),
        }),
      ),
    }),
    { headers },
  );
  for (const job of jobs.jobs) {
    console.log(`  ${job.name}: ${job.conclusion ?? 'running'}`);
    for (const step of job.steps ?? [])
      if (step.conclusion === 'failure') console.log(`    failed step: ${step.name}`);
    if (values.logs && job.conclusion === 'failure') {
      const log = await http.getText(`${api}/actions/jobs/${job.id}/logs`, { headers });
      console.log(
        log
          .split('\n')
          .filter((l) => /error|fail|✗|×/i.test(l))
          .slice(-60)
          .join('\n'),
      );
    }
  }
}
