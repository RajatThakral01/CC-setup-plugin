import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs docker CLI commands. The sandbox module is the only user (enforced by a test). */
export interface DockerCli {
  exec(args: readonly string[], options?: { timeoutMs?: number }): Promise<ExecResult>;
}

export function createDockerCli(binary = 'docker'): DockerCli {
  return {
    exec(args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        const timer = options.timeoutMs
          ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
          : undefined;
        child.on('error', reject);
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
  };
}
