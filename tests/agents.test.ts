import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { defaultConfig } from "../src/server/config.ts";
import { mockFactory, motion, testApp, testConfig } from "./helpers.ts";

describe("CLI agents seated from the UI", () => {
  it("seats each preset with the documented adapter and keeps deliberation read-only", () => {
    const app = testApp();
    const oc = app.providers.seatAgent({ tool: "opencode", model: "anthropic/claude-sonnet-4-5", committees: ["engineering"] });
    expect(oc).toMatchObject({ id: "opencode", name: "OpenCode", canExecute: true, roles: ["executor"] });
    expect(app.cfg.members.find((m) => m.id === "opencode")!.adapter).toEqual({ type: "opencode", model: "anthropic/claude-sonnet-4-5", timeoutMs: 900000 });
    expect(app.cfg.committees.find((c) => c.id === "engineering")!.members).toContain("opencode");

    const cc = app.providers.seatAgent({ tool: "claude-code", roles: ["engineer"] });
    const adapter = app.cfg.members.find((m) => m.id === cc.id)!.adapter;
    expect(adapter).toMatchObject({ type: "cli", command: "claude", args: ["-p", "{prompt}"] });
    expect((adapter as { executeArgs: string[] }).executeArgs).toContain("acceptEdits");
    expect(cc.roles).toEqual(["engineer", "executor"]);

    // Freebuff has no headless mode: it can sit, but never executes.
    const fb = app.providers.seatAgent({ tool: "freebuff", roles: ["executor"] });
    expect(fb).toMatchObject({ canExecute: false, roles: [] });

    // A second seat of the same tool gets a fresh id.
    expect(app.providers.seatAgent({ tool: "opencode" }).id).toBe("opencode-2");
  });

  it("rejects unknown tools, bad model ids and tools outside the allowlist", () => {
    const app = testApp((c) => (c.execution.allowedCommands = c.execution.allowedCommands.filter((x) => x !== "kilo")));
    expect(() => app.providers.seatAgent({ tool: "bash" as never })).toThrow(/tool must be one of/);
    expect(() => app.providers.seatAgent({ tool: "cline", model: "x; rm -rf /" })).toThrow(/model may contain/);
    expect(() => app.providers.seatAgent({ tool: "kilo" })).toThrow(/allowedCommands/);
    expect(app.providers.agents()).toEqual([]);
  });

  it("persists seats across restarts and unseats them", () => {
    const cfg = testConfig();
    const app = createApp(cfg, { adapterFactory: mockFactory });
    app.providers.seatAgent({ tool: "cline", name: "My Cline" });
    const again = createApp({ ...cfg, dataDir: app.cfg.dataDir }, { adapterFactory: mockFactory });
    expect(again.cfg.members.find((m) => m.id === "my-cline")).toMatchObject({ canExecute: true, adapter: { type: "cline" } });
    again.providers.unseatAgent("my-cline");
    expect(again.cfg.members.some((m) => m.id === "my-cline")).toBe(false);
    expect(() => again.providers.unseatAgent("atlas")).toThrow(/cortex.config.json/);
  });

  it("detects installed CLIs on PATH without running them", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-bin-"));
    const exe = join(dir, process.platform === "win32" ? "opencode.cmd" : "opencode");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    chmodSync(exe, 0o755);
    const old = process.env.PATH;
    process.env.PATH = dir + delimiter + (old ?? "");
    try {
      const found = testApp().providers.detect();
      expect(found.opencode.installed).toBe(true);
    } finally {
      process.env.PATH = old;
    }
  });
});

describe("an empty council", () => {
  it("starts with no members and refuses to debate until two are seated", () => {
    const cfg = defaultConfig();
    cfg.dataDir = mkdtempSync(join(tmpdir(), "cortex-empty-"));
    const app = createApp(cfg);
    expect(app.cfg.members).toEqual([]);
    expect(() => app.sessions.create(motion)).toThrow(/two members/);
  });

  it("picks speaker and reviewer from the seated members when none is configured", () => {
    const app = testApp((c) => {
      c.defaults.speaker = "";
      c.defaults.reviewer = "";
    });
    const s = app.sessions.create({ ...motion, members: ["atlas", "nyx", "lumen"] });
    expect(s.speaker).toBe("lumen");
    expect(s.reviewer).toBe("atlas"); // lumen also reviews, but is the speaker
    app.sessions.abort(s.id);
  });
});
