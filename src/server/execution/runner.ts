import { spawn } from "node:child_process";
import { basename } from "node:path";

export interface RunOptions {
  cwd?: string;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  allowedCommands: string[];
  onOutput?: (chunk: string) => void;
  maxOutputBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class CommandNotAllowedError extends Error {}

/**
 * Spawn a process without a shell. The executable (by basename) must be on the
 * allowlist; arguments are passed as an argv array so model output can never be
 * interpreted as shell syntax.
 */
export function runProcess(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  if (!opts.allowedCommands.includes(basename(command))) {
    return Promise.reject(new CommandNotAllowedError(`Command "${command}" is not in execution.allowedCommands.`));
  }
  const max = opts.maxOutputBytes ?? 2_000_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: false,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (cur: string, chunk: string) => (cur.length + chunk.length > max ? cur : cur + chunk);
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout = append(stdout, s);
      opts.onOutput?.(s);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr = append(stderr, s);
      opts.onOutput?.(s);
    });
    const kill = () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}
