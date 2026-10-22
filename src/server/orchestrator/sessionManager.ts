import type { CreateSessionRequest, Session } from "../../shared/types.ts";
import { newId, now } from "../util/ids.ts";
import { type Decision, Orchestrator, type OrchestratorDeps } from "./orchestrator.ts";

export class ValidationError extends Error {}

/** Creates sessions, routes Architect commands to the right orchestrator. */
export class SessionManager {
  private readonly running = new Map<string, Orchestrator>();
  private readonly done = new Map<string, Promise<void>>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Role-based routing: explicit members, else a committee, else the full parliament. */
  resolveMembers(req: CreateSessionRequest): string[] {
    const { cfg } = this.deps;
    const known = new Set(cfg.members.map((m) => m.id));
    let members: string[];
    if (req.members?.length) members = req.members;
    else if (req.committee) {
      const c = cfg.committees.find((x) => x.id === req.committee);
      if (!c) throw new ValidationError(`Unknown committee "${req.committee}".`);
      members = c.members;
    } else members = cfg.members.map((m) => m.id);
    members = [...new Set(members)];
    const unknown = members.filter((m) => !known.has(m));
    if (unknown.length) throw new ValidationError(`Unknown member(s): ${unknown.join(", ")}.`);
    if (members.length < 2) throw new ValidationError("A debate needs at least two members.");
    return members;
  }

  create(req: CreateSessionRequest): Session {
    const title = String(req.title ?? "").trim();
    const task = String(req.task ?? "").trim();
    if (!title || title.length > 200) throw new ValidationError("title is required (max 200 chars).");
    if (!task || task.length > 20000) throw new ValidationError("task is required (max 20000 chars).");
    const { defaults } = this.deps.cfg;
    const maxRounds = req.maxRounds ?? defaults.maxRounds;
    const threshold = req.consensusThreshold ?? defaults.consensusThreshold;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) throw new ValidationError("maxRounds must be 1..5.");
    if (!(threshold > 0 && threshold <= 1)) throw new ValidationError("consensusThreshold must be in (0, 1].");

    const members = this.resolveMembers(req);
    const t = now();
    const session: Session = {
      id: newId("ses"),
      title,
      task,
      status: "deliberating",
      phase: "proposal",
      round: 1,
      createdAt: t,
      updatedAt: t,
      members,
      speaker: defaults.speaker,
      reviewer: defaults.reviewer,
      maxRounds,
      consensusThreshold: threshold,
      proposals: {},
      critiques: [],
      ballots: [],
      consensus: [],
      plan: null,
      interjections: [],
      results: [],
      absent: [],
    };
    this.deps.store.save(session);
    this.deps.bus.emit({
      sessionId: session.id,
      type: "session.created",
      actor: "architect",
      text: title,
      data: { task, members, maxRounds, consensusThreshold: threshold },
    });
    const orch = new Orchestrator(session, this.deps);
    this.running.set(session.id, orch);
    const p = orch.run().finally(() => this.running.delete(session.id));
    this.done.set(session.id, p);
    return session;
  }

  get(id: string): Session | undefined {
    return this.running.get(id)?.session ?? this.deps.store.get(id);
  }

  private live(id: string): Orchestrator {
    const o = this.running.get(id);
    if (!o) throw new ValidationError(this.get(id) ? "Session is no longer running." : "Unknown session.");
    return o;
  }

  interject(id: string, text: string) {
    if (!text?.trim()) throw new ValidationError("text is required.");
    this.live(id).interject(text.trim().slice(0, 5000));
  }
  pause(id: string) {
    this.live(id).pause();
  }
  resume(id: string) {
    this.live(id).resume();
  }
  abort(id: string) {
    this.live(id).abort();
  }
  decide(id: string, d: Decision) {
    if (d.kind === "amend" && !d.text?.trim()) throw new ValidationError("Amendment text is required.");
    try {
      this.live(id).decide(d);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
  }

  /** Test helper: resolves when the session's run loop finishes. */
  settled(id: string): Promise<void> {
    return this.done.get(id) ?? Promise.resolve();
  }
}
