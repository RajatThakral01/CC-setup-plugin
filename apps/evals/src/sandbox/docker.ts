import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Written to the process's stdin, which is then closed. */
  input?: Buffer | string;
  /** Extra environment for the docker CLI process only (used to hand the relay its API key). */
  env?: Record<string, string>;
}

/** Runs docker CLI commands. Only the eval sandbox module uses it (enforced by a test). */
export interface DockerCli {
  exec(args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
}

export function createDockerCli(binary = 'docker'): DockerCli {
  return {
    exec(args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, [...args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: options.env ? { ...process.env, ...options.env } : process.env,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        const timer = options.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              child.kill('SIGKILL');
            }, options.timeoutMs)
          : undefined;
        child.on('error', reject);
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr, timedOut });
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.input ?? '');
      });
    },
  };
}
