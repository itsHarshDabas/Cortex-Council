import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelAdapter } from "../src/server/adapters/types.ts";
import { motion, testApp, waitFor } from "./helpers.ts";

const failing: ModelAdapter = {
  kind: "broken",
  complete: async () => {
    throw new Error("upstream 503");
  },
  health: async () => ({ ok: false }),
};

describe("deliberation", () => {
  it("runs propose → critique → revise → vote → synthesize and stops at the approval gate", async () => {
    const app = testApp();
    const s0 = app.sessions.create(motion);
    const s = await waitFor(app, s0.id, ["awaiting_approval"]);

    expect(Object.keys(s.proposals).sort()).toEqual(["aegis", "atlas", "forge", "lumen", "nyx"]);
    // Every member critiques every other member's proposal each round.
    expect(s.critiques.filter((c) => c.round === 1)).toHaveLength(5 * 4);
    expect(s.critiques.every((c) => c.author !== c.target)).toBe(true);
    expect(s.ballots.every((b) => !(b.voter in b.scores))).toBe(true);
    // The mock skeptic objects in round 1, so the debate needs a second round.
    expect(s.consensus[0]!.reached).toBe(false);
    expect(s.consensus.at(-1)!.reached).toBe(true);
    expect(s.plan!.tasks.length).toBeGreaterThan(0);
    expect(s.plan!.basedOn).toBe(s.consensus.at(-1)!.winner);
    // Nothing executed without approval.
    expect(s.results).toHaveLength(0);
    expect(app.bus.historyFor(s.id).some((e) => e.type.startsWith("task."))).toBe(false);
  });

  it("executes approved tasks in isolated git worktrees, verifies and reviews them", async () => {
    const app = testApp();
    const { id } = app.sessions.create(motion);
    await waitFor(app, id, ["awaiting_approval"]);
    app.sessions.decide(id, { kind: "approve" });
    const s = await waitFor(app, id, ["completed", "failed"]);

    expect(s.status).toBe("completed");
    expect(s.results.length).toBe(s.plan!.tasks.length);
    for (const r of s.results) {
      expect(r.status).toBe("passed");
      expect(r.review?.verdict).toBe("pass");
      expect(r.review?.reviewer).not.toBe(s.plan!.tasks.find((t) => t.id === r.taskId)!.executor);
      expect(existsSync(join(r.worktree!, "council", `${r.taskId}.md`))).toBe(true);
    }
    const branches = execFileSync("git", ["-C", app.executor.worktrees.repo, "branch", "--list", "cortex/*"], { encoding: "utf8" });
    expect(branches.split("\n").filter(Boolean)).toHaveLength(s.results.length);
    // The main checkout is untouched.
    expect(existsSync(join(app.executor.worktrees.repo, "council"))).toBe(false);
    // Approval is recorded, remembered and the audit chain is intact.
    const types = app.bus.historyFor(id).map((e) => e.type);
    expect(types.indexOf("architect.approved")).toBeLessThan(types.indexOf("task.started"));
    expect(app.memory.all()[0]?.sessionId).toBe(id);
    expect(app.audit.verify().ok).toBe(true);
  });

  it("runs the configured test command and fails tasks whose tests fail", async () => {
    const app = testApp((c) => {
      c.execution.testCommand = ["node", "-e", "process.exit(require('fs').existsSync('council/t1.md') ? 1 : 0)"];
    });
    const { id } = app.sessions.create(motion);
    await waitFor(app, id, ["awaiting_approval"]);
    app.sessions.decide(id, { kind: "approve" });
    const s = await waitFor(app, id, ["completed"]);
    const t1 = s.results.find((r) => r.taskId === "t1")!;
    expect(t1.tests?.exitCode).toBe(1);
    expect(t1.status).toBe("failed");
    expect(t1.review?.verdict).toBe("fail");
    expect(s.results.filter((r) => r.taskId !== "t1").every((r) => r.status === "passed")).toBe(true);
  });

  it("rejection ends the session without executing", async () => {
    const app = testApp();
    const { id } = app.sessions.create(motion);
    await waitFor(app, id, ["awaiting_approval"]);
    app.sessions.decide(id, { kind: "reject", reason: "Too risky" });
    const s = await waitFor(app, id, ["rejected"]);
    expect(s.results).toHaveLength(0);
    expect(app.memory.all()).toHaveLength(0);
  });

  it("amendments send the plan back for revision and a new vote", async () => {
    const app = testApp();
    const { id } = app.sessions.create(motion);
    const before = await waitFor(app, id, ["awaiting_approval"]);
    const round = before.round;
    const ballots = before.ballots.length;
    app.sessions.decide(id, { kind: "amend", text: "Use a token bucket, not a fixed window." });
    await new Promise((r) => setTimeout(r, 50));
    const s = await waitFor(app, id, ["awaiting_approval"]);
    expect(s.round).toBe(round + 1);
    expect(s.ballots.length).toBeGreaterThan(ballots);
    expect(s.interjections.at(-1)!.text).toContain("token bucket");
  });

  it("interjections reach later prompts", async () => {
    const app = testApp();
    const prompts: string[] = [];
    const real = app.adapters.get("atlas");
    app.adapters.set("atlas", { ...real, kind: "spy", complete: (req) => (prompts.push(req.prompt), real.complete(req)), health: real.health });
    const { id } = app.sessions.create(motion);
    app.sessions.interject(id, "Budget is zero: no paid services.");
    await waitFor(app, id, ["awaiting_approval"]);
    expect(prompts.some((p) => p.includes("Budget is zero: no paid services."))).toBe(true);
  });

  it("marks failing members absent and carries on while quorum holds", async () => {
    const app = testApp();
    app.adapters.set("nyx", failing);
    const { id } = app.sessions.create(motion);
    const s = await waitFor(app, id, ["awaiting_approval", "failed"]);
    expect(s.status).toBe("awaiting_approval");
    expect(s.proposals.nyx).toBeUndefined();
    expect(s.absent.some((a) => a.startsWith("nyx@proposal"))).toBe(true);
  });

  it("fails cleanly when quorum is lost", async () => {
    const app = testApp();
    for (const m of ["atlas", "nyx", "forge", "aegis"]) app.adapters.set(m, failing);
    const { id } = app.sessions.create(motion);
    const s = await waitFor(app, id, ["failed"]);
    expect(s.error).toMatch(/Quorum lost/);
  });

  it("falls back to the winning proposal when the Speaker is unavailable", async () => {
    const app = testApp();
    const real = app.adapters.get("lumen");
    app.adapters.set("lumen", {
      kind: "flaky-speaker",
      complete: (req) => (req.meta.phase === "synthesis" ? Promise.reject(new Error("down")) : real.complete(req)),
      health: real.health,
    });
    const { id } = app.sessions.create(motion);
    const s = await waitFor(app, id, ["awaiting_approval"]);
    expect(s.plan!.rationale).toMatch(/Speaker unavailable/);
    expect(s.plan!.tasks.length).toBeGreaterThan(0);
  });

  it("pause holds the debate and resume continues it; abort stops it", async () => {
    const app = testApp((c) => {
      for (const m of c.members) m.adapter = { type: "mock", latencyMs: 30 };
    });
    const { id } = app.sessions.create(motion);
    app.sessions.pause(id);
    expect(app.sessions.get(id)!.status).toBe("paused");
    const phase = app.sessions.get(id)!.phase;
    await new Promise((r) => setTimeout(r, 200));
    expect(app.sessions.get(id)!.phase).toBe(phase);
    app.sessions.resume(id);
    await waitFor(app, id, ["deliberating", "awaiting_approval"]);
    app.sessions.abort(id);
    const s = await waitFor(app, id, ["aborted"]);
    expect(s.results).toHaveLength(0);
  });

  it("abort at the approval gate never executes", async () => {
    const app = testApp();
    const { id } = app.sessions.create(motion);
    await waitFor(app, id, ["awaiting_approval"]);
    app.sessions.abort(id);
    const s = await waitFor(app, id, ["aborted"]);
    expect(s.results).toHaveLength(0);
    expect(() => app.sessions.decide(id, { kind: "approve" })).toThrow();
  });

  it("validates motions and committee routing", () => {
    const app = testApp();
    expect(() => app.sessions.create({ title: "", task: "x" })).toThrow(/title/);
    expect(() => app.sessions.create({ ...motion, committee: "nope" })).toThrow(/committee/);
    expect(() => app.sessions.create({ ...motion, members: ["atlas"] })).toThrow(/two members/);
    expect(app.sessions.resolveMembers({ ...motion, committee: "security" })).toEqual(["aegis", "nyx", "forge"]);
  });
});

describe("restart", () => {
  it("a session waiting for approval can still be approved after a restart", async () => {
    const { createApp } = await import("../src/server/app.ts");
    const first = testApp();
    const { id } = first.sessions.create(motion);
    await waitFor(first, id, ["awaiting_approval"]);

    const second = createApp(first.cfg);
    expect(second.sessions.get(id)?.status).toBe("awaiting_approval");
    second.sessions.decide(id, { kind: "approve" });
    const s = await waitFor(second, id, ["completed", "failed"]);
    expect(s.status).toBe("completed");
  });
});
