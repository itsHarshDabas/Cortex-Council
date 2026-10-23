import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCliConfig, AgentCliKind } from "../config.ts";
import { findOnPath } from "../execution/resolve.ts";
import { runProcess, type RunResult } from "../execution/runner.ts";
import { AdapterError, type CompletionRequest, type CompletionResult, type ExecuteRequest, type ExecuteResult, type ModelAdapter } from "./types.ts";

/**
 * First-class adapters for coding-agent CLIs, built from each tool's documented
 * headless interface (see docs/ADAPTERS.md for sources and versions):
 *
 *   OpenCode  opencode run --format json [--auto] "<prompt>"       NDJSON events
 *   Kilo Code kilo run --format json [--auto] "<prompt>"           NDJSON events (OpenCode fork)
 *   Cline     cline --json [--plan --auto-approve false | --yolo] "<p>"  NDJSON: agent_event / run_result
 *   Freebuff  interactive TUI only; no headless mode yet         → fails fast, never used as executor
 *
 * Deliberation (complete) never auto-approves tools, so a debating agent cannot
 * touch the repo. Execution (execute) auto-approves by default, but only ever
 * runs inside the task's git worktree.
 */

/** Linux caps a single argv entry at 128 KiB; longer prompts go via a file or stdin. */
export const MAX_ARG_PROMPT = 100_000;

type Mode = "complete" | "execute";

export interface Invocation {
  args: string[];
  stdin?: string;
  /** Temp files to delete after the run. */
  cleanup?: string;
}

export interface ParsedOutput {
  text: string;
  error?: string;
  usage?: CompletionResult["usage"];
}

interface Preset {
  label: string;
  command: string;
  /** false = no headless mode; complete() fails fast and execute() is not offered. */
  headless: boolean;
  invocation(cfg: AgentCliConfig, mode: Mode, prompt: string, cwd: string | undefined, timeoutMs: number): Invocation;
  parse(stdout: string): ParsedOutput;
  /** Human-readable rendering of one NDJSON line for the live task log. */
  render(line: string): string | undefined;
}

// Some CLIs colour stderr even with NO_COLOR set.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const plainLine = (line: string) => (line.trim() ? `${stripAnsi(line)}\n` : undefined);

// Yargs-style parsers treat a leading "-" as a flag, so keep prompts from starting with one.
const safePrompt = (p: string) => (p.startsWith("-") ? ` ${p}` : p);

function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") out.push(v as Record<string, unknown>);
    } catch {
      /* banner or partial line */
    }
  }
  return out;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ---------------------------------------------------------------- OpenCode / Kilo

/**
 * `opencode run --format json` emits one event per line:
 *   step_start | text {part.text} | tool_use {part.tool, part.state} |
 *   step_finish {part.tokens, part.cost, part.reason} | error {error.name, error.data.message}
 * Kilo CLI is a fork of OpenCode and uses the same stream.
 */
export function parseOpenCodeStream(stdout: string): ParsedOutput {
  const texts: string[] = [];
  let error: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawTokens = false;
  for (const ev of jsonLines(stdout)) {
    const part = obj(ev.part);
    switch (ev.type) {
      case "text": {
        const t = str(part.text);
        if (t?.trim()) texts.push(t);
        break;
      }
      case "step_finish": {
        const tokens = obj(part.tokens);
        const i = num(tokens.input);
        const o = num(tokens.output);
        if (i !== undefined || o !== undefined) sawTokens = true;
        inputTokens += i ?? 0;
        outputTokens += (o ?? 0) + (num(tokens.reasoning) ?? 0);
        break;
      }
      case "error": {
        const e = obj(ev.error);
        error = str(ev.message) ?? str(obj(e.data).message) ?? str(e.message) ?? str(e.name) ?? "unknown error";
        break;
      }
    }
  }
  return { text: texts.join("\n\n").trim(), error, usage: sawTokens ? { inputTokens, outputTokens } : undefined };
}

function renderOpenCode(line: string): string | undefined {
  const ev = jsonLines(line)[0];
  if (!ev) return plainLine(line);
  const part = obj(ev.part);
  switch (ev.type) {
    case "text":
      return str(part.text) ? `${str(part.text)}\n` : undefined;
    case "tool_use": {
      const state = obj(part.state);
      const title = str(state.title) ?? str(obj(state.input).command) ?? "";
      const status = str(state.status);
      return `→ ${str(part.tool) ?? "tool"}${title ? `: ${title}` : ""}${status && status !== "completed" ? ` [${status}]` : ""}\n`;
    }
    case "error":
      return `✖ ${parseOpenCodeStream(line).error}\n`;
    default:
      return undefined;
  }
}

function openCodeFamily(label: string, command: string): Preset {
  return {
    label,
    command,
    headless: true,
    invocation(cfg, mode, prompt) {
      const args = ["run", "--format", "json"];
      if (cfg.model) args.push("--model", cfg.model);
      if (cfg.agent) args.push("--agent", cfg.agent);
      if (mode === "execute" && cfg.autoApprove !== false) args.push("--auto");
      args.push(...(cfg.extraArgs ?? []));
      if (Buffer.byteLength(prompt) <= MAX_ARG_PROMPT) return { args: [...args, safePrompt(prompt)] };
      // Too long for argv: attach it as a file (`--file` is documented for `run`).
      const dir = mkdtempSync(join(tmpdir(), "cortex-prompt-"));
      const file = join(dir, "brief.md");
      writeFileSync(file, prompt);
      // --file is an array option, so it goes last or it would swallow the message.
      return { args: [...args, "Follow the brief in the attached file brief.md exactly.", "--file", file], cleanup: dir };
    },
    parse: parseOpenCodeStream,
    render: renderOpenCode,
  };
}

// ---------------------------------------------------------------- Cline

/**
 * `cline --json` emits NDJSON (shape captured from cline 3.0.73):
 *   {type:"agent_event", event:{type:"content_start", contentType:"text", text:<delta>, accumulated}}
 *   {type:"agent_event", event:{type:"content_end",   contentType:"text"|"tool", text?, toolName?, error?}}
 *   {type:"agent_event", event:{type:"error", error:{message}}}
 *   {type:"run_result", finishReason, text, usage:{inputTokens, outputTokens, ...}}
 *   {type:"error", message}
 * plus `hook_event` lines, which are ignored. On failure run_result.text holds the error.
 */
export function parseClineStream(stdout: string): ParsedOutput {
  let result: string | undefined;
  let failed = false;
  const texts: string[] = [];
  let error: string | undefined;
  let usage: CompletionResult["usage"];
  for (const ev of jsonLines(stdout)) {
    if (ev.type === "run_result") {
      result = str(ev.text) ?? result;
      if (ev.finishReason === "error" || ev.finishReason === "aborted") {
        failed = true;
        error ??= str(ev.text) ?? String(ev.finishReason);
      }
      const u = obj(ev.usage);
      const i = num(u.inputTokens);
      const o = num(u.outputTokens);
      if (i !== undefined || o !== undefined) usage = { inputTokens: i, outputTokens: o };
    } else if (ev.type === "agent_event") {
      const e = obj(ev.event);
      if (e.type === "content_end" && e.contentType === "text" && str(e.text)?.trim()) texts.push(str(e.text)!);
      if (e.type === "error") error = str(obj(e.error).message) ?? str(e.message) ?? "unknown error";
    } else if (ev.type === "error") {
      error ??= str(ev.message) ?? "unknown error";
    }
  }
  if (failed) return { text: "", error, usage };
  const text = (result ?? texts.join("\n\n")).trim();
  return { text, error: text ? undefined : error, usage };
}

function renderCline(line: string): string | undefined {
  const ev = jsonLines(line)[0];
  if (!ev) return plainLine(line);
  if (ev.type === "error") return `✖ ${str(ev.message) ?? "error"}\n`;
  if (ev.type !== "agent_event") return undefined; // hook_event, run_result (already streamed)
  const e = obj(ev.event);
  if (e.contentType === "text") return e.type === "content_start" ? str(e.text) : e.type === "content_end" ? "\n" : undefined;
  if (e.contentType === "tool") {
    const tool = str(e.toolName) ?? "tool";
    if (e.type === "content_start") return `→ ${tool}\n`;
    if (e.type === "content_end" && e.error) return `✖ ${tool} failed\n`;
  }
  return undefined;
}

const cline: Preset = {
  label: "Cline",
  command: "cline",
  headless: true,
  invocation(cfg, mode, prompt, cwd, timeoutMs) {
    const args = ["--json"];
    if (cfg.model) args.push("--model", cfg.model);
    if (cfg.provider) args.push("--provider", cfg.provider);
    if (cwd) args.push("--cwd", cwd);
    // Let Cline stop itself a little before Cortex would kill it, so it can report what it did.
    args.push("--timeout", String(Math.max(10, Math.floor(timeoutMs / 1000) - 5)));
    // Cline auto-approves tools by default. Deliberation must stay read-only: plan mode, no approvals
    // (non-TTY approval requests are denied). Execution uses --yolo, which also exits when done.
    if (mode === "complete") args.push("--plan", "--auto-approve", "false");
    else if (cfg.autoApprove === false) args.push("--auto-approve", "false");
    else args.push("--yolo");
    args.push(...(cfg.extraArgs ?? []));
    // A one-word prompt such as "update" would be taken as a subcommand.
    const p = /^[\w-]+$/.test(prompt) ? `${prompt}\n` : prompt;
    if (Buffer.byteLength(p) <= MAX_ARG_PROMPT) return { args: [...args, safePrompt(p)] };
    // Piped stdin is documented context for a prompt: `git diff | cline "review these changes"`.
    return { args: [...args, "Follow the brief provided on stdin exactly."], stdin: prompt };
  },
  parse: parseClineStream,
  render: renderCline,
};

// ---------------------------------------------------------------- Freebuff

/**
 * Freebuff (npm `freebuff`, built on Codebuff) is an interactive TUI with no prompt
 * argument, print mode or JSON output (CodebuffAI/freebuff#947, #1322). Driving the TUI
 * through a pty would be brittle, so by default the adapter fails fast with a clear
 * message and offers no execute(), letting the executor fall back to another member.
 * If a future release adds a print mode, set `args` (with "{prompt}") to opt in.
 */
const freebuff: Preset = {
  label: "Freebuff",
  command: "freebuff",
  headless: false,
  invocation(cfg, _mode, prompt) {
    const tpl = cfg.args ?? [];
    const args = tpl.map((a) => a.split("{prompt}").join(prompt));
    if (!tpl.some((a) => a.includes("{prompt}"))) args.push(safePrompt(prompt));
    return { args: [...args, ...(cfg.extraArgs ?? [])] };
  },
  parse: (stdout) => ({ text: stripAnsi(stdout).trim() }),
  render: plainLine,
};

export const PRESETS: Record<AgentCliKind, Preset> = {
  opencode: openCodeFamily("OpenCode", "opencode"),
  kilo: openCodeFamily("Kilo Code", "kilo"),
  cline,
  freebuff,
};

export const FREEBUFF_NO_HEADLESS =
  "Freebuff has no headless mode yet (interactive TUI only), so it cannot take part in automated debates or execution. " +
  "Use it by hand in the task's worktree, or set adapter.args once Freebuff ships a print mode.";

/** Finds an executable on PATH without spawning it (a TUI may not exit on --version). Honours PATHEXT on Windows. */
export function onPath(command: string, env = process.env): string | undefined {
  return findOnPath(command, { env });
}

function describeFailure(label: string, res: RunResult, parsed: ParsedOutput, timeoutMs: number): string {
  if (res.timedOut) return `${label} timed out after ${Math.round(timeoutMs / 1000)}s`;
  const detail = parsed.error ?? res.stderr.trim().split("\n").slice(-5).join("\n").slice(0, 400);
  const hint = res.exitCode === 124 ? " (the CLI's own time limit)" : "";
  return `${label} exited with ${res.exitCode}${hint}${detail ? `: ${detail}` : ""}`;
}

export class AgentCliAdapter implements ModelAdapter {
  readonly kind: AgentCliKind;
  private readonly preset: Preset;
  private readonly command: string;
  /** Present only when the tool can run headless (Freebuff opts in via `args`). */
  readonly execute?: (req: ExecuteRequest) => Promise<ExecuteResult>;

  constructor(
    private readonly cfg: AgentCliConfig,
    private readonly allowedCommands: string[],
    private readonly defaultTimeoutMs: number,
  ) {
    this.kind = cfg.type;
    this.preset = PRESETS[cfg.type];
    this.command = cfg.command ?? this.preset.command;
    if (this.headless) this.execute = (req) => this.run("execute", req);
  }

  private get headless(): boolean {
    return this.preset.headless || (this.cfg.type === "freebuff" && !!this.cfg.args?.length);
  }

  private async invoke(mode: Mode, prompt: string, opts: { cwd?: string; signal?: AbortSignal; onOutput?: (s: string) => void }) {
    const timeoutMs = this.cfg.timeoutMs ?? this.defaultTimeoutMs;
    const inv = this.preset.invocation(this.cfg, mode, prompt, opts.cwd, timeoutMs);
    let buf = "";
    const onOutput = opts.onOutput
      ? (chunk: string) => {
          buf += chunk;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) {
            const r = this.preset.render(l);
            if (r) opts.onOutput!(r);
          }
        }
      : undefined;
    try {
      const res = await runProcess(this.command, inv.args, {
        cwd: opts.cwd,
        stdin: inv.stdin,
        signal: opts.signal,
        onOutput,
        timeoutMs,
        allowedCommands: this.allowedCommands,
      });
      if (buf && opts.onOutput) {
        const r = this.preset.render(buf);
        if (r) opts.onOutput(r);
      }
      return { res, parsed: this.preset.parse(res.stdout), timeoutMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        throw new AdapterError(`${this.preset.label} CLI "${this.command}" is not installed or not on PATH.`);
      throw err;
    } finally {
      if (inv.cleanup) rmSync(inv.cleanup, { recursive: true, force: true });
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.headless) throw new AdapterError(FREEBUFF_NO_HEADLESS);
    const { res, parsed, timeoutMs } = await this.invoke("complete", `${req.system}\n\n${req.prompt}`, { signal: req.signal });
    if (res.exitCode !== 0 || res.timedOut) throw new AdapterError(describeFailure(this.preset.label, res, parsed, timeoutMs));
    if (!parsed.text) throw new AdapterError(`${this.preset.label} returned no answer${parsed.error ? `: ${parsed.error}` : "."}`);
    return { text: parsed.text, usage: parsed.usage };
  }

  private async run(mode: "execute", req: ExecuteRequest): Promise<ExecuteResult> {
    try {
      const { res, parsed, timeoutMs } = await this.invoke(mode, req.instructions, { cwd: req.cwd, signal: req.signal, onOutput: req.onOutput });
      const ok = res.exitCode === 0 && !res.timedOut && !parsed.error;
      const summary = parsed.text; // raw NDJSON already streamed to the live log
      const output = ok ? summary : `${describeFailure(this.preset.label, res, parsed, timeoutMs)}\n\n${summary}`.trim();
      // A clean exit that still reported an error event counts as a failure.
      return { output, exitCode: res.timedOut ? null : ok ? 0 : res.exitCode || 1 };
    } catch (err) {
      return { output: (err as Error).message, exitCode: 1 };
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.headless) {
      const found = onPath(this.command);
      return { ok: false, detail: found ? FREEBUFF_NO_HEADLESS : `${this.preset.label} CLI "${this.command}" not found on PATH.` };
    }
    try {
      const res = await runProcess(this.command, ["--version"], { timeoutMs: 10_000, allowedCommands: this.allowedCommands });
      const version = (res.stdout.trim() || res.stderr.trim()).split("\n")[0];
      return { ok: res.exitCode === 0, detail: `${this.preset.label} ${version ?? ""}`.trim() };
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      return { ok: false, detail: missing ? `${this.preset.label} CLI "${this.command}" not found on PATH.` : (err as Error).message };
    }
  }
}
