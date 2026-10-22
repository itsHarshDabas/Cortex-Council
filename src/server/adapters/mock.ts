import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "../util/async.ts";
import type { Proposal } from "../../shared/types.ts";
import type { CompletionRequest, CompletionResult, ExecuteRequest, ExecuteResult, ModelAdapter, PromptMeta } from "./types.ts";

/**
 * Deterministic, offline stand-in for a real model. Output is derived from a
 * hash of (member, task, round) so runs are reproducible, and it is shaped to
 * exercise the whole protocol: disagreement in round 1, convergence after
 * revision, objections from skeptics, a synthesized plan and a review.
 */
export class MockAdapter implements ModelAdapter {
  readonly kind = "mock";

  constructor(private readonly opts: { latencyMs?: number; failRate?: number } = {}) {}

  async health() {
    return { ok: true, detail: "offline mock" };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const m = req.meta;
    const latency = this.opts.latencyMs ?? 0;
    if (latency > 0) await sleep(latency * (0.5 + rand(m.memberId, m.phase, m.round)), req.signal);
    if (this.opts.failRate && rand(m.memberId, m.phase, m.round, "fail") < this.opts.failRate) {
      throw new Error(`mock failure for ${m.memberId} in ${m.phase}`);
    }
    return { text: "```json\n" + JSON.stringify(this.respond(m), null, 2) + "\n```" };
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const dir = join(req.cwd, "council");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${req.taskId}.md`);
    const body = `# ${req.taskId}\n\nExecuted by the mock executor.\n\n## Instructions\n\n${req.instructions}\n`;
    await writeFile(file, body, "utf8");
    const out = `mock executor: wrote council/${req.taskId}.md (${body.length} bytes)\n`;
    req.onOutput?.(out);
    return { output: out, exitCode: 0 };
  }

  private respond(m: PromptMeta): unknown {
    switch (m.phase) {
      case "proposal":
        return proposal(m);
      case "revision":
        return revision(m);
      case "critique":
        return critique(m);
      case "vote":
        return vote(m);
      case "synthesis":
        return synthesis(m);
      case "verification":
        return {
          verdict: m.testsPassed === false ? "fail" : "pass",
          findings:
            m.testsPassed === false
              ? ["Verification command failed; see test output."]
              : ["Change is scoped to the task.", "No secrets or destructive operations observed in the diff."],
        };
      default:
        return { text: `${m.memberId} has nothing to add.` };
    }
  }
}

// --- deterministic helpers -------------------------------------------------

function rand(...parts: (string | number)[]): number {
  const h = createHash("sha256").update(parts.join("|")).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

const pick = <T>(arr: T[], ...seed: (string | number)[]): T => arr[Math.floor(rand(...seed) * arr.length) % arr.length]!;

const subject = (task: string) => {
  const t = task.trim().replace(/\s+/g, " ");
  return t.length > 70 ? t.slice(0, 67) + "..." : t;
};

const lens: Record<string, { angle: string; steps: [string, string][]; risks: string[] }> = {
  strategist: {
    angle: "Ship the thinnest end-to-end slice first, then widen it.",
    steps: [
      ["Define success criteria", "Write down the measurable outcome and what is explicitly out of scope."],
      ["Build a walking skeleton", "Wire the smallest path through every layer so integration risk surfaces on day one."],
      ["Iterate on the riskiest piece", "Spend the next cycle on whatever the skeleton showed to be hardest."],
      ["Instrument and review", "Add metrics and hold a review before expanding scope."],
    ],
    risks: ["Scope creep before the skeleton works", "Success criteria too vague to verify"],
  },
  skeptic: {
    angle: "Assume it breaks; design the rollback before the rollout.",
    steps: [
      ["List assumptions", "Enumerate every assumption and how we would know it is false."],
      ["Prototype the scariest assumption", "Run a throwaway spike against the assumption most likely to be wrong."],
      ["Add guard rails", "Feature-flag the change and define a rollback trigger."],
      ["Run a failure drill", "Simulate the top failure mode and confirm recovery works."],
    ],
    risks: ["Unvalidated assumptions", "No rollback path", "Optimistic timelines"],
  },
  engineer: {
    angle: "Small, test-first changes behind clear interfaces.",
    steps: [
      ["Write failing tests", "Capture the expected behaviour as tests before touching implementation."],
      ["Implement the core module", "Add the smallest implementation that passes, behind an interface."],
      ["Integrate and refactor", "Wire it in, remove duplication, keep the diff reviewable."],
      ["Document usage", "Update README and inline docs for the new behaviour."],
    ],
    risks: ["Hidden coupling with existing modules", "Flaky tests masking regressions"],
  },
  security: {
    angle: "Least privilege, validated inputs, auditable actions.",
    steps: [
      ["Threat-model the change", "Identify assets, entry points and trust boundaries touched."],
      ["Validate inputs at boundaries", "Reject malformed data early and never build shell strings from input."],
      ["Lock down secrets and permissions", "Load secrets from env, scope tokens minimally, redact logs."],
      ["Add audit logging", "Record who approved and executed what, tamper-evidently."],
    ],
    risks: ["Secret leakage in logs", "Injection through untrusted input", "Over-privileged automation"],
  },
};

const primaryLens = (m: PromptMeta) =>
  lens[m.roles.find((r) => r in lens) ?? ""] ?? pick(Object.values(lens), m.memberId, "lens");

function proposal(m: PromptMeta) {
  const l = primaryLens(m);
  return {
    summary: `${l.angle} Applied to: ${subject(m.task)}`,
    approach: `${m.persona ?? "Generalist"} Proposed approach: ${l.angle.toLowerCase()}`,
    steps: l.steps.slice(0, 3 + Math.floor(rand(m.memberId, m.task) * 2)).map(([title, detail]) => ({ title, detail })),
    risks: l.risks,
    confidence: Math.round((0.55 + rand(m.memberId, m.task, "conf") * 0.35) * 100) / 100,
  };
}

function revision(m: PromptMeta) {
  const base = m.ownProposal;
  const l = primaryLens(m);
  const extra = pick<[string, string]>(
    [
      ["Add a rollback plan", "Define how to revert safely if verification fails."],
      ["Add automated verification", "Gate completion on a test suite that runs in CI."],
      ["Clarify ownership", "Name which agent executes and which independently reviews each step."],
    ],
    m.memberId,
    m.round,
  );
  const steps = [...(base?.steps ?? l.steps.map(([title, detail]) => ({ title, detail })))];
  if (!steps.some((s) => s.title === extra[0])) steps.push({ title: extra[0], detail: extra[1] });
  return {
    summary: base?.summary ?? l.angle,
    approach: (base?.approach ?? l.angle) + " Revised after cross-examination.",
    steps,
    risks: base?.risks ?? l.risks,
    confidence: Math.min(0.95, (base?.confidence ?? 0.6) + 0.08),
    changelog: [
      `Addressed ${m.critiquesReceived ?? 0} critique(s) from the chamber.`,
      `Added step: ${extra[0]}.`,
    ],
  };
}

function critique(m: PromptMeta) {
  return { critiques: (m.proposals ?? []).map((t) => critiqueOne(m, t)) };
}

function critiqueOne(m: PromptMeta, t: Proposal) {
  const sev = rand(m.memberId, t.author, m.round) > 0.6 ? "high" : rand(m.memberId, m.round) > 0.4 ? "medium" : "low";
  const role = m.roles[0] ?? "member";
  const weaknessBank: Record<string, string[]> = {
    skeptic: ["No rollback path if the first step fails.", "Assumes requirements are stable.", "Timeline is optimistic."],
    security: ["Does not say where secrets live.", "No audit trail for automated actions.", "Input validation is unspecified."],
    engineer: ["Steps are not independently testable.", "Interfaces between steps are undefined.", "No definition of done."],
    strategist: ["Too much up-front work before user value.", "Success criteria are missing.", "Scope is wider than the task needs."],
  };
  const bank = weaknessBank[role] ?? weaknessBank.engineer!;
  return {
    target: t.id,
    strengths: [`Clear angle: ${(t.summary).split(".")[0]}.`, `${t.steps.length} concrete steps.`],
    weaknesses: [pick(bank, m.memberId, t.author, m.round, 1), pick(bank, m.memberId, t.author, m.round, 2)].filter(
      (v, i, a) => a.indexOf(v) === i,
    ),
    questions: [`How will we verify "${t.steps[0]?.title ?? "the first step"}" succeeded?`],
    severity: sev,
  };
}

function vote(m: PromptMeta) {
  const proposals = m.proposals ?? [];
  // Each proposal has a hidden "quality"; voters disagree a lot in round 1 and converge after revision.
  const noise = m.round <= 1 ? 4.5 : 0.8;
  const scores: Record<string, { score: number; reason: string }> = {};
  for (const p of proposals) {
    if (p.author === m.memberId) continue;
    const quality = 5 + rand(p.author, m.task, "quality") * 4;
    const s = Math.round(Math.min(10, Math.max(1, quality + (rand(m.memberId, p.author, m.round) - 0.5) * noise * 2)));
    scores[p.id] = { score: s, reason: s >= 7 ? "Concrete and verifiable." : s >= 5 ? "Workable but has gaps." : "Too risky as written." };
  }
  const objections =
    m.round <= 1 && m.roles.includes("skeptic") ? ["Round 1 proposals lack an explicit rollback plan."] : [];
  return { scores, objections };
}

function synthesis(m: PromptMeta) {
  const w = m.winner;
  const executors = m.executors?.length ? m.executors : [m.memberId];
  const steps = (w?.steps ?? []).slice(0, 3);
  return {
    title: `Plan: ${subject(m.task)}`,
    rationale: `Built on ${w?.author ?? "the leading"} proposal, which scored highest after revision, with critiques from the chamber folded in.`,
    tasks: steps.map((s, i) => ({
      id: `t${i + 1}`,
      title: s.title,
      instructions: s.detail,
      executor: executors[i % executors.length],
      verify: "Run the project's test command and have an independent reviewer audit the diff.",
    })),
    risks: w?.risks ?? [],
    dissent: [],
  };
}
