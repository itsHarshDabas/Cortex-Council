import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCliAdapter, argPromptLimit, MAX_ARG_PROMPT } from "../src/server/adapters/agentCli.ts";
import { CliAdapter } from "../src/server/adapters/cli.ts";
import type { CompletionRequest, ModelAdapter } from "../src/server/adapters/types.ts";
import { debateTimeout } from "../src/server/config.ts";
import { agentAdapter } from "../src/server/core/providerService.ts";
import { motion, testApp, waitFor } from "./helpers.ts";

// A fake CLI that records argv and stdin, then prints an OpenCode-style tool call and answer.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
const done = () => {
  fs.writeFileSync(process.env.LONG_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  process.stdout.write(JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed", title: "src/app.ts" } } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "text", part: { text: "done" } }) + "\n");
};
if (process.stdin.isTTY) done();
else { process.stdin.on("data", (d) => (stdin += d)); process.stdin.on("end", done); }
`;

function fakeBin(...names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "cortex-long-"));
  for (const n of names) {
    writeFileSync(join(dir, n), FAKE);
    chmodSync(join(dir, n), 0o755);
  }
  const log = join(dir, "log.json");
  process.env.LONG_LOG = log;
  return { dir, read: () => JSON.parse(readFileSync(log, "utf8")) as { argv: string[]; stdin: string } };
}

const req = (prompt: string, extra: Partial<CompletionRequest> = {}): CompletionRequest => ({
  system: "sys",
  prompt,
  meta: { phase: "vote", memberId: "m", roles: [], round: 1, task: "t" },
  ...extra,
});

describe("long prompts", () => {
  it("keeps argv prompts far below Windows' 32,767-character command line", () => {
    expect(argPromptLimit("win32")).toBeLessThanOrEqual(8_000);
    expect(argPromptLimit("linux")).toBe(100_000);
  });

  it("sends an oversized Claude Code prompt on stdin instead of argv", async () => {
    const { dir, read } = fakeBin("claude");
    const cfg = { ...(agentAdapter("claude-code") as { args: string[]; executeArgs: string[] }), command: join(dir, "claude") };
    const a = new CliAdapter(cfg as never, ["claude"], 5000);
    const big = "v".repeat(MAX_ARG_PROMPT + 10);
    await a.complete(req(big));
    let r = read();
    expect(r.argv).toEqual(["-p"]);
    expect(r.stdin).toContain(big);
    // Short prompts stay on argv.
    await a.complete(req("short"));
    r = read();
    expect(r.argv).toEqual(["-p", "sys\n\nshort"]);
    expect(r.stdin).toBe("");
  });
});

describe("slow CLI agents", () => {
  it("gives CLI agents their own, longer debate time limit, overridable per seat", () => {
    const defaults = testApp().cfg.defaults;
    const api = { id: "a", name: "A", roles: [], adapter: { type: "openai" as const, model: "m" } };
    const cli = { id: "c", name: "C", roles: [], adapter: { type: "kilo" as const } };
    expect(debateTimeout(api, defaults)).toBe(defaults.timeoutMs);
    expect(debateTimeout(cli, defaults)).toBe(600_000);
    expect(debateTimeout({ ...cli, timeoutMs: 1_200_000 }, defaults)).toBe(1_200_000);
  });

  it("passes the time budget to the CLI and streams its tool calls as progress", async () => {
    const { dir } = fakeBin("opencode");
    const a = new AgentCliAdapter({ type: "opencode", command: join(dir, "opencode") }, ["opencode"], 5000);
    const lines: string[] = [];
    const res = await a.complete(req("hi", { timeoutMs: 4000, onProgress: (l) => lines.push(l) }));
    expect(res.text).toBe("done");
    expect(lines.join("")).toContain("→ read: src/app.ts");
  });

  it("uses each member's own time limit in the debate and shows progress while it works", async () => {
    const app = testApp((c) => {
      c.defaults.timeoutMs = 150;
      c.members.find((m) => m.id === "forge")!.timeoutMs = 5000;
    });
    const slow = (id: string): ModelAdapter => {
      const real = app.adapters.get(id);
      return {
        kind: "slow",
        health: real.health,
        complete: async (r) => {
          r.onProgress?.("→ read: src/app.ts\n");
          await new Promise((ok, fail) => {
            const t = setTimeout(ok, 400);
            r.signal?.addEventListener("abort", () => (clearTimeout(t), fail(new Error("killed"))), { once: true });
          });
          return real.complete(r);
        },
      };
    };
    app.adapters.set("forge", slow("forge"));
    app.adapters.set("nyx", slow("nyx"));
    const thinking: string[] = [];
    app.bus.subscribe((e) => e.type === "member.thinking" && e.actor === "forge" && e.text && thinking.push(e.text));
    const { id } = app.sessions.create(motion);
    const s = await waitFor(app, id, ["awaiting_approval", "failed"]);
    expect(s.proposals.forge).toBeDefined(); // 400 ms is within forge's 5 s limit
    expect(s.absent.some((a) => a.startsWith("nyx@proposal"))).toBe(true); // but over the 150 ms default
    expect(thinking.some((t) => t.includes("→ read: src/app.ts"))).toBe(true);
  });
});
