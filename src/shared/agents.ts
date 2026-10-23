// Local coding-agent CLIs seated from the UI. Shared by the server and the web UI; keep dependency-free.
import type { Role } from "./types.ts";

export type CliTool = "claude-code" | "opencode" | "kilo" | "cline" | "freebuff";

export interface CliToolPreset {
  id: CliTool;
  name: string;
  /** Executable on PATH; must be in execution.allowedCommands. */
  command: string;
  install: string;
  /** One-time sign-in, run in a terminal outside Cortex. Cortex never handles these credentials. */
  auth: string;
  /** Example model id in the tool's own format. */
  modelHint: string;
  /** Freebuff has no headless mode yet: it can be seated, but it sits out debates and never executes. */
  headless: boolean;
  docs: string;
}

export const CLI_TOOLS: readonly CliToolPreset[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    auth: "claude   (sign in once, then exit)",
    modelHint: "sonnet",
    headless: true,
    docs: "https://docs.claude.com/en/docs/claude-code",
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    install: "npm install -g opencode-ai",
    auth: "opencode auth login",
    modelHint: "anthropic/claude-sonnet-4-5",
    headless: true,
    docs: "https://opencode.ai",
  },
  {
    id: "kilo",
    name: "Kilo Code",
    command: "kilo",
    install: "npm install -g @kilocode/cli",
    auth: "kilo auth",
    modelHint: "anthropic/claude-sonnet-4-5",
    headless: true,
    docs: "https://kilo.ai/docs/cli",
  },
  {
    id: "cline",
    name: "Cline",
    command: "cline",
    install: "npm install -g cline",
    auth: "cline auth",
    modelHint: "claude-sonnet-4-5",
    headless: true,
    docs: "https://docs.cline.bot/cline-cli/overview",
  },
  {
    id: "freebuff",
    name: "Freebuff",
    command: "freebuff",
    install: "npm install -g freebuff",
    auth: "freebuff   (sign in inside the TUI)",
    modelHint: "",
    headless: false,
    docs: "https://freebuff.com",
  },
];

export interface AgentSeatInput {
  id?: string;
  name?: string;
  tool: CliTool;
  model?: string;
  roles?: Role[];
  persona?: string;
  color?: string;
  committees?: string[];
  /** Let this agent run approved tasks in a git worktree (default true; never for Freebuff). */
  canExecute?: boolean;
  /** Time limit for each debate call, in ms. Default: defaults.agentTimeoutMs (10 min). */
  timeoutMs?: number;
}

export interface AgentSeatView {
  id: string;
  name: string;
  tool: CliTool;
  model?: string;
  roles: Role[];
  persona?: string;
  color?: string;
  committees: string[];
  canExecute: boolean;
  timeoutMs?: number;
}

export interface CliToolStatus {
  installed: boolean;
  detail?: string;
}

export interface AgentsInfo {
  tools: CliToolPreset[];
  seats: AgentSeatView[];
}
