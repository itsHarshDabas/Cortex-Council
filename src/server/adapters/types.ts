import type { Phase, Proposal } from "../../shared/types.ts";

/** Structured hints for the current call. Real models ignore it (everything is in the prompt); the mock adapter uses it. */
export interface PromptMeta {
  phase: Phase;
  memberId: string;
  roles: string[];
  persona?: string;
  round: number;
  title?: string;
  task: string;
  target?: Proposal;
  ownProposal?: Proposal;
  proposals?: Proposal[];
  critiquesReceived?: number;
  winner?: Proposal;
  executors?: string[];
  testsPassed?: boolean | null;
}

export interface CompletionRequest {
  system: string;
  prompt: string;
  signal?: AbortSignal;
  meta: PromptMeta;
}

export interface CompletionResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ExecuteRequest {
  instructions: string;
  cwd: string;
  taskId: string;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export interface ExecuteResult {
  output: string;
  exitCode: number | null;
}

export interface ModelAdapter {
  readonly kind: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Only adapters that can act on a working directory (CLI agents, mock) implement this. */
  execute?(req: ExecuteRequest): Promise<ExecuteResult>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
