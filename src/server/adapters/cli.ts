import { runProcess } from "../execution/runner.ts";
import type { CompletionRequest, CompletionResult, ExecuteRequest, ExecuteResult, ModelAdapter } from "./types.ts";

/**
 * Wraps any headless agent CLI and returns raw stdout. OpenCode, Kilo Code, Cline and
 * Freebuff have dedicated adapters in agentCli.ts. Examples:
 *   Claude Code: { command: "claude",   args: ["-p", "{prompt}"] }
 *   Gemini CLI:  { command: "gemini",   args: ["-p", "{prompt}"] }
 *   Codex CLI:   { command: "codex",    args: ["exec", "{prompt}"] }
 * The prompt is substituted as a single argv entry; nothing is shell-parsed.
 */
export class CliAdapter implements ModelAdapter {
  readonly kind = "cli";

  constructor(
    private readonly cfg: { command: string; args: string[]; executeArgs?: string[]; promptVia?: "arg" | "stdin"; timeoutMs?: number },
    private readonly allowedCommands: string[],
    private readonly defaultTimeoutMs: number,
  ) {}

  private argv(prompt: string, template = this.cfg.args): { args: string[]; stdin?: string } {
    if (this.cfg.promptVia === "stdin") return { args: template.filter((a) => a !== "{prompt}"), stdin: prompt };
    const args = template.map((a) => a.split("{prompt}").join(prompt));
    if (!template.some((a) => a.includes("{prompt}"))) args.push(prompt);
    return { args };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const { args, stdin } = this.argv(`${req.system}\n\n${req.prompt}`);
    const res = await runProcess(this.cfg.command, args, {
      stdin,
      signal: req.signal,
      timeoutMs: this.cfg.timeoutMs ?? this.defaultTimeoutMs,
      allowedCommands: this.allowedCommands,
    });
    if (res.exitCode !== 0) throw new Error(`${this.cfg.command} exited with ${res.exitCode}: ${res.stderr.slice(0, 300)}`);
    return { text: res.stdout };
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const { args, stdin } = this.argv(req.instructions, this.cfg.executeArgs ?? this.cfg.args);
    const res = await runProcess(this.cfg.command, args, {
      cwd: req.cwd,
      stdin,
      signal: req.signal,
      onOutput: req.onOutput,
      timeoutMs: this.cfg.timeoutMs ?? this.defaultTimeoutMs,
      allowedCommands: this.allowedCommands,
    });
    return { output: res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : ""), exitCode: res.timedOut ? null : res.exitCode };
  }

  async health() {
    try {
      const res = await runProcess(this.cfg.command, ["--version"], { timeoutMs: 10_000, allowedCommands: this.allowedCommands });
      return { ok: res.exitCode === 0, detail: res.stdout.trim().split("\n")[0] };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
