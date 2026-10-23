// Types shared by the server and the web UI. Keep this file dependency-free.

export type Role =
  | "strategist"
  | "skeptic"
  | "engineer"
  | "security"
  | "reviewer"
  | "researcher"
  | "speaker"
  | "executor";

export interface MemberInfo {
  id: string;
  name: string;
  adapter: string;
  model?: string;
  roles: Role[];
  color: string;
  /** Members flagged as executors can run approved tasks (CLI agents, mock). */
  canExecute: boolean;
  /** Seated from the UI on a managed API provider (editable there); otherwise from cortex.config.json. */
  managed?: boolean;
  provider?: string;
}

export interface CommitteeInfo {
  id: string;
  name: string;
  description: string;
  members: string[];
}

export type SessionStatus =
  | "deliberating"
  | "paused"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "rejected"
  | "aborted"
  | "failed";

export type Phase =
  | "proposal"
  | "critique"
  | "revision"
  | "vote"
  | "synthesis"
  | "approval"
  | "execution"
  | "verification"
  | "report";

export interface ProposalStep {
  title: string;
  detail: string;
}

export interface Proposal {
  id: string; // "<memberId>"; one live proposal per member
  author: string;
  round: number;
  summary: string;
  approach: string;
  steps: ProposalStep[];
  risks: string[];
  confidence: number; // 0..1
  changelog: string[];
  raw?: string;
}

export interface Critique {
  author: string;
  target: string;
  round: number;
  strengths: string[];
  weaknesses: string[];
  questions: string[];
  severity: "low" | "medium" | "high";
}

export interface Ballot {
  voter: string;
  round: number;
  scores: Record<string, { score: number; reason: string }>;
  objections: string[];
}

export interface ProposalTally {
  proposalId: string;
  mean: number;
  agreement: number; // 0..1, 1 = voters fully agree on this proposal's score
  votes: number;
}

export interface ConsensusResult {
  round: number;
  tallies: ProposalTally[];
  winner: string | null;
  agreement: number;
  reached: boolean;
  blockingObjections: string[];
}

export interface PlanTask {
  id: string;
  title: string;
  instructions: string;
  executor: string; // member id
  verify?: string; // human-readable or command hint
}

export interface UnifiedPlan {
  title: string;
  rationale: string;
  basedOn: string | null;
  tasks: PlanTask[];
  risks: string[];
  dissent: string[];
}

export type TaskStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  branch?: string;
  worktree?: string;
  output: string;
  diffStat?: string;
  tests?: { command: string; exitCode: number | null; output: string };
  review?: { reviewer: string; verdict: "pass" | "fail" | "concerns"; findings: string[] };
  startedAt?: string;
  finishedAt?: string;
}

export interface Interjection {
  at: string;
  text: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  phase: Phase;
  round: number;
  createdAt: string;
  updatedAt: string;
}

export interface Session extends SessionSummary {
  task: string;
  members: string[];
  speaker: string;
  reviewer: string;
  maxRounds: number;
  consensusThreshold: number;
  proposals: Record<string, Proposal>;
  critiques: Critique[];
  ballots: Ballot[];
  consensus: ConsensusResult[];
  plan: UnifiedPlan | null;
  interjections: Interjection[];
  results: TaskResult[];
  absent: string[];
  error?: string;
}

export type CouncilEventType =
  | "session.created"
  | "session.status"
  | "phase.started"
  | "member.thinking"
  | "member.spoke"
  | "member.absent"
  | "proposal.submitted"
  | "critique.submitted"
  | "ballot.cast"
  | "consensus.computed"
  | "plan.synthesized"
  | "architect.interjected"
  | "architect.approved"
  | "architect.rejected"
  | "architect.amended"
  | "task.started"
  | "task.output"
  | "task.finished"
  | "session.report"
  | "provider.saved"
  | "provider.removed"
  | "member.seated"
  | "member.unseated"
  | "error";

export interface CouncilEvent {
  seq: number;
  at: string;
  sessionId: string;
  type: CouncilEventType;
  actor: string; // member id, "architect", or "system"
  phase?: Phase;
  text?: string;
  data?: unknown;
}

export interface CreateSessionRequest {
  title: string;
  task: string;
  committee?: string;
  members?: string[];
  maxRounds?: number;
  consensusThreshold?: number;
}
