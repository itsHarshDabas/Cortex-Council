import type {
  Ballot,
  CouncilEvent,
  Critique,
  Phase,
  PlanTask,
  Proposal,
  Session,
  SessionStatus,
  UnifiedPlan,
} from "../../shared/types.ts";
import type { PromptMeta } from "../adapters/types.ts";
import type { AdapterRegistry } from "../adapters/registry.ts";
import { commandOf, type CortexConfig, debateTimeout, type MemberConfig } from "../config.ts";
import type { EventBus } from "../core/eventBus.ts";
import type { ProjectMemory, MemoryEntry } from "../core/memory.ts";
import type { SessionStore } from "../core/store.ts";
import type { ExecutionService } from "../execution/executor.ts";
import { AbortedError, mapLimit, withRetry } from "../util/async.ts";
import { now, slug } from "../util/ids.ts";
import { asNumber, asString, asStringArray, clamp, extractJson } from "../util/json.ts";
import { computeConsensus } from "./consensus.ts";
import * as P from "./prompts.ts";

export type Decision = { kind: "approve"; note?: string } | { kind: "reject"; reason?: string } | { kind: "amend"; text: string };

export interface OrchestratorDeps {
  cfg: CortexConfig;
  adapters: AdapterRegistry;
  bus: EventBus;
  store: SessionStore;
  memory: ProjectMemory;
  executor: ExecutionService;
}

type Json = Record<string, unknown>;
const MIN_QUORUM = 2;

/**
 * Drives one motion through the deliberation protocol:
 * propose → (critique → revise → vote)×N → synthesize → approval gate → execute → verify → report.
 * The Architect can interject, pause, resume or abort at any point.
 */
export class Orchestrator {
  private readonly ctrl = new AbortController();
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private decide_: ((d: Decision) => void) | null = null;
  private recalled: MemoryEntry[] = [];

  constructor(
    readonly session: Session,
    private readonly deps: OrchestratorDeps,
  ) {}

  // ---- Architect controls -------------------------------------------------

  interject(text: string): void {
    this.session.interjections.push({ at: now(), text });
    this.save();
    this.emit({ type: "architect.interjected", actor: "architect", text });
  }

  pause(): void {
    if (this.session.status !== "deliberating" && this.session.status !== "executing") return;
    this.paused = true;
    this.setStatus("paused");
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.setStatus(this.session.phase === "execution" || this.session.phase === "verification" ? "executing" : "deliberating");
    for (const w of this.resumeWaiters.splice(0)) w();
  }

  abort(): void {
    this.ctrl.abort();
    for (const w of this.resumeWaiters.splice(0)) w();
    // A session parked at the approval gate has no pending model call to observe the abort.
    if (this.decide_) this.decide_({ kind: "reject", reason: "aborted" });
  }

  decide(d: Decision): void {
    if (this.session.status !== "awaiting_approval" || !this.decide_) {
      throw new Error(`Session is ${this.session.status}, not awaiting approval.`);
    }
    const resolve = this.decide_;
    this.decide_ = null;
    resolve(d);
  }

  // ---- main loop ----------------------------------------------------------

  async run(): Promise<void> {
    await this.guarded(async () => {
      const s = this.session;
      this.recalled = this.deps.memory.recall(`${s.title} ${s.task}`);
      await this.proposalPhase();

      let consensusReached = false;
      for (let r = 1; r <= s.maxRounds; r++) {
        s.round = r;
        await this.critiquePhase();
        await this.revisionPhase();
        consensusReached = await this.votePhase();
        if (consensusReached) break;
      }
      await this.synthesisPhase(consensusReached);
      await this.approvalAndExecution();
    });
  }

  /** Re-attach to a session that was parked at the approval gate before a restart. */
  async resumeAtGate(): Promise<void> {
    await this.guarded(async () => {
      const s = this.session;
      this.recalled = this.deps.memory.recall(`${s.title} ${s.task}`);
      await this.approvalAndExecution();
    });
  }

  private async approvalAndExecution(): Promise<void> {
    const s = this.session;
    // Approval gate: nothing executes without an explicit approve.
    for (;;) {
      const decision = await this.awaitDecision();
      if (decision.kind === "reject") {
        if (this.ctrl.signal.aborted) throw new AbortedError();
        this.emit({ type: "architect.rejected", actor: "architect", phase: "approval", text: decision.reason ?? "Plan rejected." });
        this.setStatus("rejected");
        return;
      }
      if (decision.kind === "approve") {
        this.emit({ type: "architect.approved", actor: "architect", phase: "approval", text: decision.note ?? "Plan approved." });
        this.rememberDecision();
        break;
      }
      // Amendment: binding instruction, then revise → vote → re-synthesize.
      s.interjections.push({ at: now(), text: `Amendment: ${decision.text}` });
      this.emit({ type: "architect.amended", actor: "architect", phase: "approval", text: decision.text });
      this.setStatus("deliberating");
      s.round += 1;
      await this.revisionPhase();
      const reached = await this.votePhase();
      await this.synthesisPhase(reached);
    }
    await this.executionPhase();
  }

  private async guarded(fn: () => Promise<void>): Promise<void> {
    const s = this.session;
    try {
      await fn();
    } catch (err) {
      if (err instanceof AbortedError || this.ctrl.signal.aborted) {
        this.setStatus("aborted");
        this.emit({ type: "session.status", actor: "architect", text: "Session aborted by the Architect." });
      } else {
        s.error = (err as Error).message;
        this.setStatus("failed");
        this.emit({ type: "error", actor: "system", text: s.error });
      }
    }
  }

  // ---- phases -------------------------------------------------------------

  private async proposalPhase(): Promise<void> {
    this.startPhase("proposal", "Members draft proposals independently.");
    const members = this.members();
    await mapLimit(members, this.deps.cfg.defaults.concurrency, async (m) => {
      const j = await this.ask(m, "proposal", P.proposalPrompt(this.session, this.recalled));
      if (!j) return;
      const p = normalizeProposal(m.id, 1, j);
      this.session.proposals[p.id] = p;
      this.save();
      this.emit({ type: "proposal.submitted", actor: m.id, phase: "proposal", text: p.summary, data: p });
    });
    this.requireQuorum(Object.keys(this.session.proposals).length, "proposals");
  }

  private async critiquePhase(): Promise<void> {
    const s = this.session;
    this.startPhase("critique", `Round ${s.round}: cross-examination.`);
    const ids = new Set(Object.keys(s.proposals));
    await mapLimit(this.members(), this.deps.cfg.defaults.concurrency, async (m) => {
      const others = Object.values(s.proposals).filter((p) => p.author !== m.id);
      if (others.length === 0) return;
      const j = await this.ask(m, "critique", P.critiquePrompt(s, this.recalled, others), { proposals: others });
      if (!j) return;
      // Accept {critiques:[...]} or, when only one proposal was shown, a bare critique object.
      const list = Array.isArray(j.critiques) ? (j.critiques as Json[]) : [j];
      const critiques: Critique[] = [];
      for (const c of list) {
        const target = asString(c.target, others.length === 1 ? others[0]!.id : "");
        if (!ids.has(target) || target === m.id || critiques.some((x) => x.target === target)) continue;
        critiques.push(normalizeCritique(m.id, target, s.round, c));
      }
      for (const c of critiques) {
        s.critiques.push(c);
        this.emit({
          type: "critique.submitted",
          actor: m.id,
          phase: "critique",
          text: `→ ${this.nameOf(c.target)}: ${c.weaknesses[0] ?? "no major weaknesses"}`,
          data: c,
        });
      }
      this.save();
    });
  }

  private async revisionPhase(): Promise<void> {
    const s = this.session;
    this.startPhase("revision", `Round ${s.round}: authors revise under critique.`);
    const authors = this.members().filter((m) => s.proposals[m.id]);
    await mapLimit(authors, this.deps.cfg.defaults.concurrency, async (m) => {
      const own = s.proposals[m.id]!;
      const received = s.critiques.filter((c) => c.target === m.id && c.round === s.round);
      const j = await this.ask(m, "revision", P.revisionPrompt(s, this.recalled, own, received), {
        ownProposal: own,
        critiquesReceived: received.length,
      });
      if (!j) return; // absent: the previous version stands
      const p = normalizeProposal(m.id, s.round, j, own);
      s.proposals[m.id] = p;
      this.save();
      this.emit({
        type: "proposal.submitted",
        actor: m.id,
        phase: "revision",
        text: p.changelog.length ? `Revised: ${p.changelog.join(" ")}` : `Revised: ${p.summary}`,
        data: p,
      });
    });
  }

  private async votePhase(): Promise<boolean> {
    const s = this.session;
    this.startPhase("vote", `Round ${s.round}: members score every proposal.`);
    const proposals = Object.values(s.proposals);
    const ballots: Ballot[] = [];
    await mapLimit(this.members(), this.deps.cfg.defaults.concurrency, async (m) => {
      const j = await this.ask(m, "vote", P.votePrompt(s, this.recalled, proposals, m.id), { proposals });
      if (!j) return;
      const b = normalizeBallot(m.id, s.round, j, new Set(proposals.map((p) => p.id)));
      ballots.push(b);
      s.ballots.push(b);
      const top = Object.entries(b.scores).sort((a, z) => z[1].score - a[1].score)[0];
      this.emit({
        type: "ballot.cast",
        actor: m.id,
        phase: "vote",
        text: top ? `Backs ${this.nameOf(top[0])} (${top[1].score}/10)${b.objections.length ? ` · objects: ${b.objections[0]}` : ""}` : "Abstains.",
        data: b,
      });
    });
    this.requireQuorum(ballots.length, "ballots");
    const result = computeConsensus(ballots, proposals.map((p) => p.id), s.round, s.consensusThreshold);
    s.consensus.push(result);
    this.save();
    this.emit({
      type: "consensus.computed",
      actor: "system",
      phase: "vote",
      text: result.reached
        ? `Consensus reached on ${this.nameOf(result.winner ?? "")}'s proposal (agreement ${(result.agreement * 100).toFixed(0)}%).`
        : `No consensus yet: leader ${result.winner ? this.nameOf(result.winner) : "none"}, agreement ${(result.agreement * 100).toFixed(0)}%${
            result.blockingObjections.length ? `, ${result.blockingObjections.length} objection(s)` : ""
          }.`,
      data: result,
    });
    return result.reached;
  }

  private async synthesisPhase(consensusReached: boolean): Promise<void> {
    const s = this.session;
    this.startPhase("synthesis", "The Speaker synthesizes one plan.");
    const last = s.consensus.at(-1);
    const winner = (last?.winner && s.proposals[last.winner]) || Object.values(s.proposals)[0]!;
    const executors = this.deps.cfg.members.filter((m) => m.canExecute).map((m) => ({ id: m.id, name: m.name }));
    const speaker = this.member(s.speaker);
    const openCritiques = s.critiques.filter((c) => c.round === s.round && c.severity !== "low");
    const objections = consensusReached ? [] : (last?.blockingObjections ?? []);

    const j = speaker
      ? await this.ask(
          speaker,
          "synthesis",
          P.synthesisPrompt(s, this.recalled, winner, Object.values(s.proposals), openCritiques, executors, objections),
          { winner, executors: executors.map((e) => e.id) },
        )
      : null;
    const plan = j ? normalizePlan(j, winner, executors[0]?.id ?? s.speaker) : fallbackPlan(s.task, winner, executors[0]?.id ?? s.speaker);
    if (!j) plan.rationale += " (Speaker unavailable: plan assembled directly from the winning proposal.)";
    if (!consensusReached) {
      plan.dissent.push(
        `Consensus threshold not met (agreement ${((last?.agreement ?? 0) * 100).toFixed(0)}% vs ${(s.consensusThreshold * 100).toFixed(0)}% required).`,
        ...objections,
      );
    }
    plan.dissent = [...new Set(plan.dissent)];
    s.plan = plan;
    s.phase = "approval";
    this.setStatus("awaiting_approval");
    this.emit({ type: "plan.synthesized", actor: speaker?.id ?? "system", phase: "synthesis", text: plan.title, data: plan });
  }

  private async executionPhase(): Promise<void> {
    const s = this.session;
    const plan = s.plan!;
    this.setStatus("executing");
    this.startPhase("execution", `Executing ${plan.tasks.length} task(s) in isolated worktrees.`);
    await this.deps.executor.worktrees.ensureRepo();
    s.results = plan.tasks.map((t) => ({ taskId: t.id, status: "pending", output: "" }));
    this.save();
    for (let i = 0; i < plan.tasks.length; i++) {
      await this.checkpoint();
      const task = plan.tasks[i]!;
      let result;
      try {
        result = await this.deps.executor.runTask(s, task, (e) => this.emit(e), this.ctrl.signal);
      } catch (err) {
        if (this.ctrl.signal.aborted) throw new AbortedError();
        result = { taskId: task.id, status: "failed" as const, output: `Execution error: ${(err as Error).message}`, finishedAt: now() };
        this.emit({ type: "task.finished", actor: "system", phase: "execution", text: `${task.title}: failed`, data: result });
      }
      s.results[i] = result;
      this.save();
    }
    s.phase = "report";
    const passed = s.results.filter((r) => r.status === "passed").length;
    const failed = s.results.filter((r) => r.status === "failed").length;
    this.setStatus("completed");
    this.emit({
      type: "session.report",
      actor: "system",
      phase: "report",
      text: `${passed}/${s.results.length} task(s) passed${failed ? `, ${failed} failed` : ""}. Branches are ready for your review.`,
      data: { results: s.results, workspace: this.deps.executor.worktrees.repo },
    });
  }

  // ---- helpers ------------------------------------------------------------

  private members(): MemberConfig[] {
    return this.session.members.map((id) => this.member(id)).filter((m): m is MemberConfig => Boolean(m));
  }

  private nameOf(id: string): string {
    return this.member(id)?.name ?? id;
  }

  private member(id: string): MemberConfig | undefined {
    return this.deps.cfg.members.find((m) => m.id === id);
  }

  private async ask(m: MemberConfig, phase: Phase, prompt: string, extra: Partial<PromptMeta> = {}): Promise<Json | null> {
    await this.checkpoint();
    const s = this.session;
    this.emit({ type: "member.thinking", actor: m.id, phase });
    const meta: PromptMeta = { phase, memberId: m.id, title: s.title, roles: m.roles, persona: m.persona, round: s.round, task: s.task, ...extra };
    const { defaults } = this.deps.cfg;
    const timeoutMs = debateTimeout(m, defaults);
    // Progress for slow members (CLI agents can take minutes): elapsed time plus their latest tool call.
    const started = Date.now();
    let last = "";
    let lastSent = 0;
    const progress = (force = false) => {
      if (!force && Date.now() - lastSent < 2000) return;
      lastSent = Date.now();
      const mins = Math.floor((Date.now() - started) / 60_000);
      const text = [phase, mins ? `${mins}m` : "", last].filter(Boolean).join(" · ");
      this.emit({ type: "member.thinking", actor: m.id, phase, text });
    };
    const heartbeat = setInterval(() => progress(true), 30_000);
    heartbeat.unref?.();
    const onProgress = (line: string) => {
      const l = line.trim().split("\n").at(-1)?.slice(0, 80);
      if (!l) return;
      last = l;
      progress();
    };
    try {
      const res = await withRetry(
        (signal) => this.deps.adapters.get(m.id).complete({ system: P.systemPrompt(m), prompt, signal, meta, timeoutMs, onProgress }),
        { retries: defaults.retries, timeoutMs, signal: this.ctrl.signal, retryOnTimeout: !commandOf(m.adapter) },
      );
      const json = extractJson<Json>(res.text);
      if (json) return json;
      // Unstructured answer: keep it visible and let normalizers build a fallback.
      this.emit({ type: "member.spoke", actor: m.id, phase, text: res.text.slice(0, 2000) });
      return { __raw: res.text, summary: res.text.slice(0, 280), approach: res.text };
    } catch (err) {
      if (err instanceof AbortedError || this.ctrl.signal.aborted) throw new AbortedError();
      s.absent.push(`${m.id}@${phase}#${s.round}`);
      this.save();
      this.emit({ type: "member.absent", actor: m.id, phase, text: `Absent from ${phase}: ${(err as Error).message}` });
      return null;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async checkpoint(): Promise<void> {
    if (this.ctrl.signal.aborted) throw new AbortedError();
    while (this.paused) {
      await new Promise<void>((r) => this.resumeWaiters.push(r));
      if (this.ctrl.signal.aborted) throw new AbortedError();
    }
  }

  private awaitDecision(): Promise<Decision> {
    if (this.ctrl.signal.aborted) return Promise.reject(new AbortedError());
    return new Promise((resolve) => (this.decide_ = resolve));
  }

  private requireQuorum(n: number, what: string): void {
    if (n < MIN_QUORUM) throw new Error(`Quorum lost: only ${n} member(s) produced ${what} (need ${MIN_QUORUM}).`);
  }

  private rememberDecision(): void {
    const s = this.session;
    const plan = s.plan!;
    this.deps.memory.add({
      sessionId: s.id,
      title: plan.title,
      content: `${plan.rationale} Tasks: ${plan.tasks.map((t) => t.title).join("; ")}.`,
      tags: [slug(s.title)],
    });
  }

  private startPhase(phase: Phase, text: string): void {
    this.session.phase = phase;
    this.save();
    this.emit({ type: "phase.started", actor: "system", phase, text, data: { round: this.session.round } });
  }

  private setStatus(status: SessionStatus): void {
    this.session.status = status;
    this.save();
    this.emit({ type: "session.status", actor: "system", phase: this.session.phase, text: status, data: { status } });
  }

  private save(): void {
    this.deps.store.save(this.session);
  }

  private emit(e: Omit<CouncilEvent, "seq" | "at" | "sessionId">): void {
    this.deps.bus.emit({ ...e, sessionId: this.session.id });
  }
}

// ---- normalizers: tolerate whatever shape a model returns -----------------

export function normalizeProposal(author: string, round: number, j: Json, prev?: Proposal): Proposal {
  const steps = Array.isArray(j.steps)
    ? (j.steps as unknown[]).map((st, i) =>
        typeof st === "string"
          ? { title: `Step ${i + 1}`, detail: st }
          : { title: asString((st as Json)?.title, `Step ${i + 1}`), detail: asString((st as Json)?.detail ?? (st as Json)?.description) },
      )
    : (prev?.steps ?? []);
  return {
    id: author,
    author,
    round,
    summary: asString(j.summary, prev?.summary ?? "").slice(0, 1000) || "(no summary)",
    approach: asString(j.approach, prev?.approach ?? ""),
    steps,
    risks: asStringArray(j.risks).length ? asStringArray(j.risks) : (prev?.risks ?? []),
    confidence: clamp(asNumber(j.confidence, prev?.confidence ?? 0.5), 0, 1),
    changelog: asStringArray(j.changelog),
    raw: typeof j.__raw === "string" ? j.__raw : undefined,
  };
}

export function normalizeCritique(author: string, target: string, round: number, j: Json): Critique {
  const sev = asString(j.severity);
  return {
    author,
    target,
    round,
    strengths: asStringArray(j.strengths),
    weaknesses: asStringArray(j.weaknesses).length ? asStringArray(j.weaknesses) : typeof j.__raw === "string" ? [j.__raw.slice(0, 500)] : [],
    questions: asStringArray(j.questions),
    severity: sev === "low" || sev === "high" ? sev : "medium",
  };
}

export function normalizeBallot(voter: string, round: number, j: Json, valid: Set<string>): Ballot {
  const scores: Ballot["scores"] = {};
  const raw = (j.scores && typeof j.scores === "object" ? j.scores : {}) as Json;
  for (const [id, v] of Object.entries(raw)) {
    if (!valid.has(id) || id === voter) continue;
    const score = typeof v === "number" ? v : asNumber((v as Json)?.score, NaN);
    if (!Number.isFinite(score)) continue;
    scores[id] = { score: clamp(Math.round(score), 1, 10), reason: asString((v as Json)?.reason) };
  }
  return { voter, round, scores, objections: asStringArray(j.objections) };
}

export function normalizePlan(j: Json, winner: Proposal, defaultExecutor: string): UnifiedPlan {
  const tasks: PlanTask[] = Array.isArray(j.tasks)
    ? (j.tasks as Json[]).map((t, i) => ({
        id: slug(asString(t.id, `t${i + 1}`)) || `t${i + 1}`,
        title: asString(t.title, `Task ${i + 1}`),
        instructions: asString(t.instructions ?? t.detail ?? t.description),
        executor: asString(t.executor, defaultExecutor),
        verify: asString(t.verify) || undefined,
      }))
    : [];
  // Task ids must be unique: they become branch and directory names.
  const seen = new Set<string>();
  for (const t of tasks) {
    let id = t.id;
    for (let n = 2; seen.has(id); n++) id = `${t.id}-${n}`;
    t.id = id;
    seen.add(id);
  }
  if (tasks.length === 0) return fallbackPlan(asString(j.title, winner.summary), winner, defaultExecutor);
  return {
    title: asString(j.title, winner.summary).slice(0, 200),
    rationale: asString(j.rationale),
    basedOn: winner.id,
    tasks,
    risks: asStringArray(j.risks),
    dissent: asStringArray(j.dissent),
  };
}

export function fallbackPlan(title: string, winner: Proposal, executor: string): UnifiedPlan {
  return {
    title: `Plan: ${title.slice(0, 120)}`,
    rationale: `Adopted proposal from ${winner.author}: ${winner.summary}`,
    basedOn: winner.id,
    tasks: (winner.steps.length ? winner.steps : [{ title: "Implement", detail: winner.approach }]).map((st, i) => ({
      id: `t${i + 1}`,
      title: st.title,
      instructions: st.detail,
      executor,
    })),
    risks: winner.risks,
    dissent: [],
  };
}
