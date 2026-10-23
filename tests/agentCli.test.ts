import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentCliAdapter, FREEBUFF_NO_HEADLESS, MAX_ARG_PROMPT, parseClineStream, parseOpenCodeStream } from "../src/server/adapters/agentCli.ts";
import { AdapterError, type CompletionRequest } from "../src/server/adapters/types.ts";
import { ConfigError, validateConfig, type AgentCliConfig } from "../src/server/config.ts";
import { testApp, validConfig } from "./helpers.ts";

/**
 * Each fake CLI is a tiny Node script named like the real tool. It records argv, cwd and
 * stdin to $FAKE_LOG, then replays a scripted NDJSON stream chosen by $FAKE_SCENARIO.
 */
const FAKE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
let stdin = "";
const done = () => {
  const fileIdx = argv.indexOf("--file");
  const file = fileIdx >= 0 ? fs.readFileSync(argv[fileIdx + 1], "utf8") : undefined;
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ name, argv, cwd: process.cwd(), stdin, file, fileArg: argv[fileIdx + 1] }));
  const s = process.env.FAKE_SCENARIO || "ok";
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (argv[0] === "--version") { console.log(name + " 9.9.9"); return; }
  if (s === "slow") { setTimeout(() => {}, 60000); return; }
  if (name === "cline") {
    out({ type: "hook_event", hookEventName: "agent_start" });
    out({ type: "agent_event", event: { type: "iteration_start", iteration: 1 } });
    if (s === "ok") {
      out({ type: "agent_event", event: { type: "content_start", contentType: "tool", toolName: "read_file", input: {} } });
      out({ type: "agent_event", event: { type: "content_end", contentType: "tool", toolName: "read_file", output: "..." } });
      out({ type: "agent_event", event: { type: "content_start", contentType: "text", text: "Final answer ", accumulated: "Final answer " } });
      out({ type: "agent_event", event: { type: "content_start", contentType: "text", text: "from Cline", accumulated: "Final answer from Cline" } });
      out({ type: "agent_event", event: { type: "content_end", contentType: "text", text: "Final answer from Cline" } });
      out({ type: "run_result", finishReason: "completed", text: "Final answer from Cline", usage: { inputTokens: 12, outputTokens: 3, totalCost: 0 } });
    } else {
      // Captured from cline 3.0.73 with no network access.
      out({ type: "agent_event", event: { type: "error", error: { name: "Error", message: "request blocked: host api.cline.bot" }, errorClass: "auth", recoverable: false } });
      out({ type: "run_result", finishReason: "error", iterations: 1, usage: { inputTokens: 0, outputTokens: 0 }, text: "request blocked: host api.cline.bot" });
      out({ type: "error", message: "request blocked: host api.cline.bot" });
      process.exit(s === "fail-exit0" ? 0 : 1);
    }
    return;
  }
  if (name === "freebuff") { process.stdout.write("freebuff says hi\n"); return; }
  // opencode / kilo
  process.stdout.write("some banner line\n");
  out({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } });
  if (s === "ok") {
    out({ type: "tool_use", sessionID: "ses_1", part: { tool: "bash", state: { status: "completed", title: "echo hello", input: { command: "echo hello" } } } });
    out({ type: "text", sessionID: "ses_1", part: { type: "text", text: "Hello from " + name } });
    out({ type: "step_finish", sessionID: "ses_1", part: { reason: "stop", cost: 0.001, tokens: { input: 671, output: 8, reasoning: 2, cache: { read: 0, write: 0 } } } });
  } else if (s === "error" || s === "error-exit0") {
    out({ type: "error", sessionID: "ses_1", error: { name: "APIError", data: { message: "Rate limit exceeded", statusCode: 429 } } });
    if (s === "error") process.exit(1);
  }
};
if (process.stdin.isTTY) done();
else { process.stdin.on("data", (d) => (stdin += d)); process.stdin.on("end", done); }
`;

let bin: string;
let log: string;
const allowed = ["opencode", "kilo", "cline", "freebuff"];

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "cortex-fake-cli-"));
  for (const name of allowed) {
    writeFileSync(join(bin, name), FAKE);
    chmodSync(join(bin, name), 0o755);
  }
  log = join(bin, "log.json");
  process.env.FAKE_LOG = log;
});

afterEach(() => {
  process.env.FAKE_SCENARIO = "ok";
});

const recorded = () => JSON.parse(readFileSync(log, "utf8")) as { name: string; argv: string[]; cwd: string; stdin: string; file?: string; fileArg?: string };

function adapter(cfg: Partial<AgentCliConfig> & { type: AgentCliConfig["type"] }, timeoutMs = 10_000) {
  return new AgentCliAdapter({ command: join(bin, cfg.type), ...cfg }, allowed, timeoutMs);
}

const req = (prompt = "Propose a plan"): CompletionRequest => ({
  system: "You are a member of the parliament.",
  prompt,
  meta: { phase: "proposal", memberId: "x", roles: [], round: 1, task: "t" },
});

describe("output parsers", () => {
  it("joins OpenCode text parts and sums tokens across steps", () => {
    const stream = [
      { type: "text", part: { text: "one" } },
      { type: "step_finish", part: { reason: "tool-calls", tokens: { input: 10, output: 1, reasoning: 0 } } },
      { type: "text", part: { text: "two" } },
      { type: "step_finish", part: { reason: "stop", tokens: { input: 20, output: 2, reasoning: 3 } } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(parseOpenCodeStream(`noise\n${stream}\n{broken`)).toEqual({ text: "one\n\ntwo", error: undefined, usage: { inputTokens: 30, outputTokens: 6 } });
  });

  it("surfaces OpenCode error events", () => {
    const line = JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Rate limit exceeded" } } });
    expect(parseOpenCodeStream(line).error).toBe("Rate limit exceeded");
  });

  it("prefers Cline's run_result over streamed agent events", () => {
    const s = [
      { type: "agent_event", event: { type: "content_end", contentType: "text", text: "thinking" } },
      { type: "run_result", finishReason: "completed", text: "done" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(parseClineStream(s).text).toBe("done");
    const partial = JSON.stringify({ type: "agent_event", event: { type: "content_end", contentType: "text", text: "partial" } });
    expect(parseClineStream(partial).text).toBe("partial");
  });

  it("never treats Cline's error run_result text as an answer", () => {
    const s = JSON.stringify({ type: "run_result", finishReason: "error", text: "auth failed" });
    expect(parseClineStream(s)).toMatchObject({ text: "", error: "auth failed" });
  });
});

describe.each(["opencode", "kilo"] as const)("%s adapter", (type) => {
  it("deliberates read-only with JSON output and parses the answer", async () => {
    const res = await adapter({ type, model: "anthropic/claude-sonnet-4-5", agent: "plan" }).complete(req());
    expect(res.text).toBe(`Hello from ${type}`);
    expect(res.usage).toEqual({ inputTokens: 671, outputTokens: 10 });
    const r = recorded();
    expect(r.argv.slice(0, 3)).toEqual(["run", "--format", "json"]);
    expect(r.argv).toContain("--model");
    expect(r.argv).toContain("plan");
    expect(r.argv).not.toContain("--auto");
    expect(r.argv.at(-1)).toContain("Propose a plan");
  });

  it("executes autonomously inside the worktree and streams readable output", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-wt-"));
    const chunks: string[] = [];
    const res = await adapter({ type }).execute!({ instructions: "Add a test", cwd, taskId: "t1", onOutput: (c) => chunks.push(c) });
    expect(res.exitCode).toBe(0);
    expect(res.output).toBe(`Hello from ${type}`);
    expect(recorded().argv).toContain("--auto");
    expect(recorded().cwd).toBe(cwd);
    expect(chunks.join("")).toContain("→ bash: echo hello");
    expect(chunks.join("")).not.toContain('"type"');
  });

  it("honours autoApprove: false", async () => {
    await adapter({ type, autoApprove: false }).execute!({ instructions: "x", cwd: tmpdir(), taskId: "t" });
    expect(recorded().argv).not.toContain("--auto");
  });

  it("turns error events into failures, even when the CLI exits 0", async () => {
    process.env.FAKE_SCENARIO = "error";
    await expect(adapter({ type }).complete(req())).rejects.toThrow(/exited with 1: Rate limit exceeded/);
    process.env.FAKE_SCENARIO = "error-exit0";
    const res = await adapter({ type }).execute!({ instructions: "x", cwd: tmpdir(), taskId: "t" });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain("Rate limit exceeded");
  });

  it("passes oversized prompts as an attached file and cleans it up", async () => {
    const big = "x".repeat(MAX_ARG_PROMPT + 10);
    await adapter({ type }).complete(req(big));
    const r = recorded();
    expect(r.file).toContain(big);
    expect(r.argv.join(" ").length).toBeLessThan(MAX_ARG_PROMPT);
    expect(existsSync(r.fileArg!)).toBe(false);
  });

  it("never lets a prompt be parsed as a flag", async () => {
    await adapter({ type }).execute!({ instructions: "--help me", cwd: tmpdir(), taskId: "t" });
    expect(recorded().argv.at(-1)).toBe(" --help me");
  });
});

describe("cline adapter", () => {
  it("deliberates in plan mode with tool approvals off", async () => {
    const res = await adapter({ type: "cline", provider: "anthropic", model: "claude-sonnet-4-6" }).complete(req());
    expect(res).toEqual({ text: "Final answer from Cline", usage: { inputTokens: 12, outputTokens: 3 } });
    const { argv } = recorded();
    expect(argv[0]).toBe("--json");
    expect(argv).toEqual(expect.arrayContaining(["--plan", "--auto-approve", "false", "--provider", "anthropic", "--timeout", "10"]));
    expect(argv).not.toContain("--yolo");
  });

  it("executes with --yolo in the worktree", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cortex-wt-"));
    const chunks: string[] = [];
    const res = await adapter({ type: "cline" }).execute!({ instructions: "Fix it", cwd, taskId: "t", onOutput: (c) => chunks.push(c) });
    expect(res).toEqual({ output: "Final answer from Cline", exitCode: 0 });
    const r = recorded();
    expect(r.argv).toEqual(expect.arrayContaining(["--yolo", "--cwd", cwd]));
    expect(r.cwd).toBe(cwd);
    expect(chunks.join("")).toBe("→ read_file\nFinal answer from Cline\n");
  });

  it("pipes oversized prompts through stdin", async () => {
    const big = "y".repeat(MAX_ARG_PROMPT + 10);
    await adapter({ type: "cline" }).complete(req(big));
    const r = recorded();
    expect(r.stdin).toContain(big);
    expect(r.argv.at(-1)).toMatch(/stdin/);
  });

  it("reports Cline's error when the run fails", async () => {
    process.env.FAKE_SCENARIO = "fail";
    await expect(adapter({ type: "cline" }).complete(req())).rejects.toThrow(/Cline exited with 1: request blocked/);
    process.env.FAKE_SCENARIO = "fail-exit0";
    await expect(adapter({ type: "cline" }).complete(req())).rejects.toThrow(/returned no answer: request blocked/);
    const res = await adapter({ type: "cline" }).execute!({ instructions: "x", cwd: tmpdir(), taskId: "t" });
    expect(res.exitCode).toBe(1);
  });

  it("keeps a one-word prompt from being read as a subcommand", async () => {
    await adapter({ type: "cline" }).execute!({ instructions: "update", cwd: tmpdir(), taskId: "t" });
    expect(recorded().argv.at(-1)).toBe("update\n");
  });

  it("kills runs that exceed the timeout", async () => {
    process.env.FAKE_SCENARIO = "slow";
    const res = await adapter({ type: "cline" }, 300).execute!({ instructions: "x", cwd: tmpdir(), taskId: "t" });
    expect(res.exitCode).toBeNull();
    expect(res.output).toMatch(/timed out/);
  });
});

describe("freebuff adapter", () => {
  it("fails fast and offers no executor while Freebuff has no headless mode", async () => {
    const a = adapter({ type: "freebuff" });
    expect(a.execute).toBeUndefined();
    await expect(a.complete(req())).rejects.toThrow(FREEBUFF_NO_HEADLESS);
    expect(await a.health()).toEqual({ ok: false, detail: FREEBUFF_NO_HEADLESS });
  });

  it("can opt in to a future print mode via an args template", async () => {
    const a = adapter({ type: "freebuff", args: ["--print", "{prompt}"] });
    expect(a.execute).toBeDefined();
    expect((await a.complete(req())).text).toBe("freebuff says hi");
    expect(recorded().argv[0]).toBe("--print");
  });
});

describe("health and installation", () => {
  it("reports the version of an installed CLI", async () => {
    expect(await adapter({ type: "opencode" }).health()).toEqual({ ok: true, detail: "OpenCode opencode 9.9.9" });
  });

  it("explains a missing binary instead of crashing", async () => {
    const a = new AgentCliAdapter({ type: "kilo", command: join(bin, "nope", "kilo") }, allowed, 5000);
    await expect(a.complete(req())).rejects.toBeInstanceOf(AdapterError);
    await expect(a.complete(req())).rejects.toThrow(/not installed/);
    expect((await a.health()).detail).toMatch(/not found/);
  });
});

describe("config and executor integration", () => {
  it("validates agent CLI members against the allowlist", () => {
    const c = validConfig();
    c.members[0]!.adapter = { type: "cline" };
    c.members[1]!.adapter = { type: "kilo", command: "/usr/local/bin/kilo" };
    expect(() => validateConfig(c)).not.toThrow();
    c.execution.allowedCommands = c.execution.allowedCommands.filter((x) => x !== "kilo");
    expect(() => validateConfig(c)).toThrow(/kilo.*allowedCommands/);
  });

  it("requires {prompt} in a freebuff args template", () => {
    const c = validConfig();
    c.members[0]!.adapter = { type: "freebuff", args: ["--print"] };
    expect(() => validateConfig(c)).toThrow(ConfigError);
  });

  it("falls back to another executor when Freebuff is chosen", () => {
    const app = testApp((c) => {
      c.members[0]!.canExecute = true;
      c.members[0]!.adapter = { type: "freebuff", command: join(bin, "freebuff") };
    });
    const id = app.cfg.members[0]!.id;
    const chosen = app.executor.resolveExecutor(id);
    expect(chosen?.id).not.toBe(id);
    expect(chosen?.canExecute).toBe(true);
  });
});
