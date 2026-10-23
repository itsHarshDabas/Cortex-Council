import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { CommitteeInfo, Role } from "../shared/types.ts";

export const AGENT_CLIS = ["opencode", "kilo", "cline", "freebuff"] as const;
export type AgentCliKind = (typeof AGENT_CLIS)[number];

/** Dedicated coding-agent CLI adapters (see src/server/adapters/agentCli.ts and docs/ADAPTERS.md). */
export interface AgentCliConfig {
  type: AgentCliKind;
  /** Executable; defaults to opencode | kilo | cline | freebuff. Must be in execution.allowedCommands. */
  command?: string;
  /** Model id in the tool's own format, e.g. "anthropic/claude-sonnet-4-5". Omit to use the tool's default. */
  model?: string;
  /** OpenCode / Kilo: named agent (e.g. "build"). */
  agent?: string;
  /** Cline: provider id (e.g. "anthropic", "openrouter"). */
  provider?: string;
  /** Auto-approve tool calls when executing in a worktree (default true). Deliberation never auto-approves. */
  autoApprove?: boolean;
  /** Extra argv inserted before the prompt. */
  extraArgs?: string[];
  /** Freebuff only: opt-in argv template ("{prompt}") for when it ships a headless mode. */
  args?: string[];
  timeoutMs?: number;
}

export type AdapterConfig =
  | { type: "mock"; latencyMs?: number; failRate?: number }
  | { type: "openai"; baseUrl?: string; model: string; apiKeyEnv?: string; temperature?: number; maxTokens?: number }
  | { type: "anthropic"; baseUrl?: string; model: string; apiKeyEnv?: string; maxTokens?: number }
  | { type: "gemini"; baseUrl?: string; model: string; apiKeyEnv?: string }
  | {
      type: "cli";
      command: string;
      /** Arguments; "{prompt}" is replaced by the prompt text (one argv entry, never shell-parsed). */
      args: string[];
      promptVia?: "arg" | "stdin";
      timeoutMs?: number;
    }
  | AgentCliConfig;

export interface MemberConfig {
  id: string;
  name: string;
  roles: Role[];
  color?: string;
  persona?: string;
  canExecute?: boolean;
  adapter: AdapterConfig;
}

export interface CortexConfig {
  server: { host: string; port: number };
  dataDir: string;
  members: MemberConfig[];
  committees: CommitteeInfo[];
  defaults: {
    speaker: string;
    reviewer: string;
    maxRounds: number;
    consensusThreshold: number;
    concurrency: number;
    timeoutMs: number;
    retries: number;
  };
  execution: {
    /** Git repo where approved tasks run (in worktrees). null = a sandbox repo inside dataDir. */
    workspace: string | null;
    allowedCommands: string[];
    /** argv for the verification step, run inside each task's worktree. Empty = skip. */
    testCommand: string[];
    timeoutMs: number;
  };
}

const palette = ["#38bdf8", "#f472b6", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#22d3ee", "#c084fc"];

export const defaultConfig = (): CortexConfig => ({
  server: { host: "127.0.0.1", port: 7420 },
  dataDir: ".cortex",
  members: [
    {
      id: "atlas",
      name: "Atlas",
      roles: ["strategist"],
      persona: "Big-picture strategist. Optimizes for simplicity, sequencing and user value.",
      adapter: { type: "mock", latencyMs: 900 },
    },
    {
      id: "nyx",
      name: "Nyx",
      roles: ["skeptic"],
      persona: "Professional skeptic. Hunts hidden assumptions, failure modes and scope creep.",
      adapter: { type: "mock", latencyMs: 900 },
    },
    {
      id: "forge",
      name: "Forge",
      roles: ["engineer", "executor"],
      persona: "Pragmatic senior engineer. Concrete steps, testability, smallest working change.",
      canExecute: true,
      adapter: { type: "mock", latencyMs: 900 },
    },
    {
      id: "aegis",
      name: "Aegis",
      roles: ["security"],
      persona: "Security and reliability reviewer. Least privilege, data safety, rollback paths.",
      adapter: { type: "mock", latencyMs: 900 },
    },
    {
      id: "lumen",
      name: "Lumen",
      roles: ["speaker", "reviewer"],
      persona: "Impartial speaker. Synthesizes the strongest plan and preserves dissent.",
      adapter: { type: "mock", latencyMs: 900 },
    },
  ],
  committees: [
    {
      id: "full",
      name: "Full Parliament",
      description: "Every seated member deliberates.",
      members: ["atlas", "nyx", "forge", "aegis", "lumen"],
    },
    {
      id: "engineering",
      name: "Engineering Committee",
      description: "Design and implementation decisions.",
      members: ["atlas", "forge", "nyx"],
    },
    {
      id: "security",
      name: "Security Review Board",
      description: "Threat modelling and hardening.",
      members: ["aegis", "nyx", "forge"],
    },
  ],
  defaults: {
    speaker: "lumen",
    reviewer: "aegis",
    maxRounds: 2,
    consensusThreshold: 0.75,
    concurrency: 4,
    timeoutMs: 120_000,
    retries: 1,
  },
  execution: {
    workspace: null,
    allowedCommands: ["git", "npm", "pnpm", "node", "claude", "opencode", "kilo", "cline", "freebuff", "gemini", "codex", "aider"],
    testCommand: [],
    timeoutMs: 600_000,
  },
});

export class ConfigError extends Error {}

/** The executable a member spawns, if any. */
export function commandOf(a: AdapterConfig): string | undefined {
  if (a.type === "cli") return a.command;
  if ((AGENT_CLIS as readonly string[]).includes(a.type)) return (a as AgentCliConfig).command ?? a.type;
  return undefined;
}

/** Load cortex.config.json (or CORTEX_CONFIG), merged over defaults, then validated. */
export function loadConfig(path = process.env.CORTEX_CONFIG ?? "cortex.config.json"): CortexConfig {
  const base = defaultConfig();
  const full = resolve(path);
  let cfg = base;
  if (existsSync(full)) {
    let user: Partial<CortexConfig>;
    try {
      user = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      throw new ConfigError(`Invalid JSON in ${full}: ${(err as Error).message}`);
    }
    cfg = {
      ...base,
      ...user,
      server: { ...base.server, ...user.server },
      defaults: { ...base.defaults, ...user.defaults },
      execution: { ...base.execution, ...user.execution },
      members: user.members ?? base.members,
      committees: user.committees ?? base.committees,
    };
  }
  if (process.env.CORTEX_PORT) cfg.server.port = Number(process.env.CORTEX_PORT);
  if (process.env.CORTEX_HOST) cfg.server.host = process.env.CORTEX_HOST;
  if (process.env.CORTEX_DATA_DIR) cfg.dataDir = process.env.CORTEX_DATA_DIR;
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: CortexConfig): void {
  const ids = new Set<string>();
  if (cfg.members.length < 2) throw new ConfigError("At least two members are needed for a debate.");
  cfg.members.forEach((m, i) => {
    if (!m.id || !/^[a-z0-9][a-z0-9_-]*$/i.test(m.id)) throw new ConfigError(`Member #${i} has an invalid id "${m.id}".`);
    if (ids.has(m.id)) throw new ConfigError(`Duplicate member id "${m.id}".`);
    ids.add(m.id);
    if (!m.adapter?.type) throw new ConfigError(`Member "${m.id}" has no adapter.type.`);
    if (!["mock", "openai", "anthropic", "gemini", "cli", ...AGENT_CLIS].includes(m.adapter.type))
      throw new ConfigError(`Member "${m.id}" uses unknown adapter "${m.adapter.type}".`);
    const command = commandOf(m.adapter);
    if (command && !cfg.execution.allowedCommands.includes(basename(command)))
      throw new ConfigError(`Member "${m.id}" runs "${command}", which is not in execution.allowedCommands.`);
    if (m.adapter.type === "freebuff" && m.adapter.args && !m.adapter.args.some((a) => a.includes("{prompt}")))
      throw new ConfigError(`Member "${m.id}": freebuff adapter.args must contain "{prompt}".`);
    m.color ??= palette[i % palette.length];
    m.roles ??= [];
  });
  for (const c of cfg.committees) {
    for (const id of c.members) if (!ids.has(id)) throw new ConfigError(`Committee "${c.id}" references unknown member "${id}".`);
  }
  for (const key of ["speaker", "reviewer"] as const) {
    if (!ids.has(cfg.defaults[key])) throw new ConfigError(`defaults.${key} "${cfg.defaults[key]}" is not a member.`);
  }
  if (cfg.defaults.maxRounds < 1 || cfg.defaults.maxRounds > 5) throw new ConfigError("defaults.maxRounds must be 1..5.");
  if (cfg.defaults.consensusThreshold <= 0 || cfg.defaults.consensusThreshold > 1)
    throw new ConfigError("defaults.consensusThreshold must be in (0, 1].");
}
