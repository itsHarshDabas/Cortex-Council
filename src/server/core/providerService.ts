import { CLI_TOOLS, type AgentSeatInput, type AgentSeatView, type CliTool, type CliToolStatus } from "../../shared/agents.ts";
import type { ProviderInput, ProviderTestInput, ProviderTestResult, ProviderView, SeatInput, SeatView } from "../../shared/providers.ts";
import { onPath } from "../adapters/agentCli.ts";
import type { AdapterRegistry } from "../adapters/registry.ts";
import { listModels } from "../adapters/models.ts";
import { palette, type AdapterConfig, type CortexConfig, type MemberConfig } from "../config.ts";
import { ConflictError, type SessionManager, ValidationError } from "../orchestrator/sessionManager.ts";
import { commandName } from "../execution/runner.ts";
import { registerSecret } from "../util/redact.ts";
import type { EventBus } from "./eventBus.ts";
import { normalizeBaseUrl, type ProviderStore } from "./providers.ts";

/** Audit events for configuration changes go to this pseudo-session. */
export const SYSTEM_SESSION = "system";

export function seatToMember(seat: SeatView, index: number): MemberConfig {
  return {
    id: seat.id,
    name: seat.name,
    roles: seat.roles,
    color: seat.color ?? palette[index % palette.length],
    persona: seat.persona,
    canExecute: false,
    adapter: { type: "provider", provider: seat.provider, model: seat.model, temperature: seat.temperature, maxTokens: seat.maxTokens },
  };
}

const AGENT_TIMEOUT_MS = 900_000;

/** The adapter for a UI-seated CLI agent, built from the same presets as docs/ADAPTERS.md. */
export function agentAdapter(tool: CliTool, model?: string): AdapterConfig {
  if (tool === "claude-code") {
    const m = model ? ["--model", model] : [];
    // Deliberation runs in the server's directory, so it gets no edit permission; execution runs in a worktree.
    return { type: "cli", command: "claude", args: ["-p", "{prompt}", ...m], executeArgs: ["-p", "{prompt}", ...m, "--permission-mode", "acceptEdits"], timeoutMs: AGENT_TIMEOUT_MS };
  }
  return { type: tool, ...(model ? { model } : {}), timeoutMs: AGENT_TIMEOUT_MS };
}

export function agentToMember(seat: AgentSeatView, index: number): MemberConfig {
  return {
    id: seat.id,
    name: seat.name,
    roles: seat.roles,
    color: seat.color ?? palette[index % palette.length],
    persona: seat.persona,
    canExecute: seat.canExecute,
    adapter: agentAdapter(seat.tool, seat.model),
  };
}

/** Merge saved seats into the loaded config (startup). Seats whose id clashes with a config member are skipped. */
export function mergeSeats(cfg: CortexConfig, store: ProviderStore): string[] {
  const skipped: string[] = [];
  const seats = [
    ...store.listAgents().map((a) => ({ seat: a, toMember: (i: number) => agentToMember(a, i) })),
    ...store.listSeats().map((s) => ({ seat: s, toMember: (i: number) => seatToMember(s, i) })),
  ];
  for (const { seat, toMember } of seats) {
    if (cfg.members.some((m) => m.id === seat.id)) {
      skipped.push(seat.id);
      continue;
    }
    cfg.members.push(toMember(cfg.members.length));
    joinCommittees(cfg, seat);
  }
  return skipped;
}

function joinCommittees(cfg: CortexConfig, seat: { id: string; committees: string[] }) {
  for (const c of cfg.committees) {
    const want = seat.committees.includes(c.id);
    const has = c.members.includes(seat.id);
    if (want && !has) c.members.push(seat.id);
    if (!want && has) c.members = c.members.filter((m) => m !== seat.id);
  }
}

/**
 * Add, edit, test and remove API providers and the members seated on them, live.
 * Every change is audited (never with key material) and takes effect without a restart.
 */
export class ProviderService {
  constructor(
    private readonly deps: { cfg: CortexConfig; adapters: AdapterRegistry; store: ProviderStore; bus: EventBus; sessions: SessionManager },
  ) {}

  private audit(type: "provider.saved" | "provider.removed" | "member.seated" | "member.unseated", text: string, data: unknown) {
    this.deps.bus.emit({ sessionId: SYSTEM_SESSION, type, actor: "architect", text, data });
  }

  list(): ProviderView[] {
    return this.deps.store.list();
  }

  create(input: Partial<ProviderInput>): ProviderView {
    const p = this.deps.store.create(input);
    this.audit("provider.saved", `Added provider ${p.name}`, { id: p.id, kind: p.kind, baseUrl: p.baseUrl, keySource: p.keySource, apiKeyEnv: p.apiKeyEnv });
    return this.deps.store.view(p);
  }

  update(id: string, input: Partial<ProviderInput>): ProviderView {
    const p = this.deps.store.update(id, input);
    // New URL or key: rebuild every adapter seated on this provider.
    for (const m of this.deps.cfg.members) if (m.adapter.type === "provider" && m.adapter.provider === id) this.deps.adapters.load(m);
    this.audit("provider.saved", `Updated provider ${p.name}`, {
      id: p.id,
      kind: p.kind,
      baseUrl: p.baseUrl,
      keySource: p.keySource,
      apiKeyEnv: p.apiKeyEnv,
      keyChanged: Boolean(input.apiKey),
    });
    return this.deps.store.view(p);
  }

  remove(id: string): void {
    const p = this.deps.store.get(id);
    if (!p) throw new ValidationError(`Unknown provider "${id}".`);
    const users = this.deps.cfg.members.filter((m) => m.adapter.type === "provider" && m.adapter.provider === id).map((m) => m.id);
    if (users.length) throw new ConflictError(`Unseat ${users.join(", ")} before removing ${p.name}.`);
    this.deps.store.remove(id);
    this.audit("provider.removed", `Removed provider ${p.name}`, { id });
  }

  /** Probe a draft or saved provider by listing its models. */
  async test(input: ProviderTestInput): Promise<ProviderTestResult> {
    const { store } = this.deps;
    const saved = input.id ? store.get(input.id) : undefined;
    if (input.id && !saved) throw new ValidationError(`Unknown provider "${input.id}".`);
    const kind = input.kind ?? saved?.kind;
    if (kind !== "openai" && kind !== "anthropic" && kind !== "gemini") throw new ValidationError("kind is required.");
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? saved?.baseUrl, kind);
    const keySource = input.keySource ?? saved?.keySource ?? "none";
    let key: string | undefined;
    if (keySource === "env") {
      const env = String(input.apiKeyEnv ?? saved?.apiKeyEnv ?? "");
      key = env ? process.env[env] : undefined;
      if (!key) return { ok: false, latencyMs: 0, models: [], detail: `Environment variable ${env || "(none)"} is not set where Cortex runs.` };
    } else if (keySource === "stored") {
      key = input.apiKey?.trim() || (saved ? store.resolve(saved.id)?.apiKey : undefined);
      if (!key) return { ok: false, latencyMs: 0, models: [], detail: "Paste an API key to test." };
    }
    registerSecret(key);
    return listModels(kind, baseUrl, key);
  }

  // ---- seats ---------------------------------------------------------------

  seats(): SeatView[] {
    return this.deps.store.listSeats();
  }

  private validCommittees(seat: { committees: string[] }) {
    const known = new Set(this.deps.cfg.committees.map((c) => c.id));
    const bad = seat.committees.filter((c) => !known.has(c));
    if (bad.length) throw new ValidationError(`Unknown committee(s): ${bad.join(", ")}.`);
  }

  seat(input: Partial<SeatInput>): SeatView {
    const { cfg, store, adapters } = this.deps;
    const seat = store.parseSeat(input, new Set(cfg.members.map((m) => m.id)));
    this.validCommittees(seat);
    const member = seatToMember(seat, cfg.members.length);
    adapters.load(member); // throws before anything is saved if the provider cannot be resolved
    store.putSeat(seat);
    cfg.members.push(member);
    joinCommittees(cfg, seat);
    this.audit("member.seated", `Seated ${seat.name} (${seat.model} via ${seat.provider})`, { id: seat.id, provider: seat.provider, model: seat.model, roles: seat.roles, committees: seat.committees });
    return seat;
  }

  updateSeat(id: string, input: Partial<SeatInput>): SeatView {
    const { cfg, store, adapters } = this.deps;
    const existing = store.getSeat(id);
    if (!existing) throw new ValidationError(`"${id}" is not a UI-managed member; edit cortex.config.json instead.`);
    const seat = store.parseSeat(input, new Set(), existing);
    this.validCommittees(seat);
    const i = cfg.members.findIndex((m) => m.id === id);
    if (i >= 0 && cfg.members[i]!.adapter.type !== "provider") throw new ConflictError(`"${id}" is defined in cortex.config.json.`);
    const member = seatToMember(seat, i < 0 ? cfg.members.length : i);
    if (!seat.color && i >= 0) member.color = cfg.members[i]!.color;
    adapters.load(member);
    store.putSeat(seat);
    if (i >= 0) cfg.members[i] = member;
    else cfg.members.push(member);
    joinCommittees(cfg, seat);
    this.audit("member.seated", `Updated ${seat.name} (${seat.model} via ${seat.provider})`, { id: seat.id, provider: seat.provider, model: seat.model, roles: seat.roles, committees: seat.committees });
    return seat;
  }

  unseat(id: string): void {
    const { cfg, store, adapters, sessions } = this.deps;
    const seat = store.getSeat(id);
    if (!seat) throw new ValidationError(`"${id}" is not a UI-managed member; edit cortex.config.json instead.`);
    if (sessions.activeMembers().has(id)) throw new ConflictError(`${seat.name} is sitting in a running session. Finish or abort it first.`);
    if (cfg.defaults.speaker === id || cfg.defaults.reviewer === id) throw new ConflictError(`${seat.name} is the default speaker or reviewer.`);
    store.removeSeat(id);
    const i = cfg.members.findIndex((m) => m.id === id && m.adapter.type === "provider");
    if (i >= 0) cfg.members.splice(i, 1);
    joinCommittees(cfg, { ...seat, committees: [] });
    adapters.delete(id);
    this.audit("member.unseated", `Unseated ${seat.name}`, { id });
  }

  // ---- CLI agents ----------------------------------------------------------

  agents(): AgentSeatView[] {
    return this.deps.store.listAgents();
  }

  /** Which preset CLIs are on the server's PATH. Looks the binary up without running it. */
  detect(): Record<CliTool, CliToolStatus> {
    const out = {} as Record<CliTool, CliToolStatus>;
    for (const t of CLI_TOOLS) {
      const found = onPath(t.command);
      out[t.id] = { installed: Boolean(found), ...(found ? { detail: found } : {}) };
    }
    return out;
  }

  seatAgent(input: Partial<AgentSeatInput>): AgentSeatView {
    const { cfg, store, adapters } = this.deps;
    const agent = store.parseAgent(input, new Set(cfg.members.map((m) => m.id)));
    this.validCommittees(agent);
    const member = agentToMember(agent, cfg.members.length);
    const command = CLI_TOOLS.find((t) => t.id === agent.tool)!.command;
    if (!cfg.execution.allowedCommands.includes(commandName(command)))
      throw new ValidationError(`"${command}" is not in execution.allowedCommands in cortex.config.json.`);
    adapters.load(member);
    store.putAgent(agent);
    cfg.members.push(member);
    joinCommittees(cfg, agent);
    this.audit("member.seated", `Seated ${agent.name} (${agent.tool}${agent.model ? ` · ${agent.model}` : ""})`, {
      id: agent.id,
      tool: agent.tool,
      model: agent.model,
      roles: agent.roles,
      committees: agent.committees,
      canExecute: agent.canExecute,
    });
    return agent;
  }

  unseatAgent(id: string): void {
    const { cfg, store, adapters, sessions } = this.deps;
    const agent = store.getAgent(id);
    if (!agent) throw new ValidationError(`"${id}" is not a UI-managed member; edit cortex.config.json instead.`);
    if (sessions.activeMembers().has(id)) throw new ConflictError(`${agent.name} is sitting in a running session. Finish or abort it first.`);
    if (cfg.defaults.speaker === id || cfg.defaults.reviewer === id) throw new ConflictError(`${agent.name} is the default speaker or reviewer.`);
    // A cortex.config.json member with the same id wins at startup; never remove that one.
    const ours = JSON.stringify(agentAdapter(agent.tool, agent.model));
    const i = cfg.members.findIndex((m) => m.id === id && JSON.stringify(m.adapter) === ours);
    store.removeAgent(id);
    if (i >= 0) cfg.members.splice(i, 1);
    joinCommittees(cfg, { id, committees: [] });
    adapters.delete(id);
    this.audit("member.unseated", `Unseated ${agent.name}`, { id });
  }
}
