import type { Critique, Interjection, Proposal, Session, TaskResult } from "../../shared/types.ts";
import type { MemberConfig } from "../config.ts";
import type { MemoryEntry } from "../core/memory.ts";

export function systemPrompt(m: MemberConfig): string {
  return [
    `You are ${m.name}, a seated member of Cortex Council, a parliament of AI agents that deliberates before any action is taken.`,
    `Your roles: ${m.roles.join(", ") || "member"}.`,
    m.persona ? `Your character: ${m.persona}` : "",
    "A human Architect has final authority. Other members are peers: question their reasoning, point out weaknesses, and change your mind when shown better evidence.",
    "Be concrete and evidence-driven. Prefer verifiable steps over vague advice.",
    "Respond with ONE JSON object only, matching the schema you are given. No prose outside the JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}

function context(s: Session, memory: MemoryEntry[]): string {
  const parts = [`## Motion\n${s.title}\n\n## Task\n${s.task}`];
  if (memory.length) parts.push("## Project memory (previously approved decisions)\n" + memory.map((m) => `- ${m.title}: ${m.content}`).join("\n"));
  if (s.interjections.length) parts.push("## Architect's instructions (binding)\n" + s.interjections.map((i: Interjection) => `- ${i.text}`).join("\n"));
  return parts.join("\n\n");
}

const fmtProposal = (p: Proposal) =>
  [
    `### Proposal ${p.id} (by ${p.author}, confidence ${p.confidence})`,
    `Summary: ${p.summary}`,
    `Approach: ${p.approach}`,
    "Steps:",
    ...p.steps.map((st, i) => `  ${i + 1}. ${st.title}: ${st.detail}`),
    `Risks: ${p.risks.join("; ") || "none listed"}`,
  ].join("\n");

const fmtCritique = (c: Critique) =>
  [
    `- From ${c.author} (severity ${c.severity})`,
    `  Weaknesses: ${c.weaknesses.join("; ") || "none"}`,
    `  Questions: ${c.questions.join("; ") || "none"}`,
  ].join("\n");

export const PROPOSAL_SCHEMA = `{"summary": string, "approach": string, "steps": [{"title": string, "detail": string}], "risks": string[], "confidence": number (0..1)}`;

export function proposalPrompt(s: Session, memory: MemoryEntry[]): string {
  return `${context(s, memory)}\n\nIndependently propose how to accomplish the task. You have not seen anyone else's proposal.\nSchema: ${PROPOSAL_SCHEMA}`;
}

export function critiquePrompt(s: Session, memory: MemoryEntry[], others: Proposal[]): string {
  return `${context(s, memory)}\n\n## Proposals from other members\n${others.map(fmtProposal).join("\n\n")}\n\nCritique EACH proposal above. Be specific: name the flaw, why it matters, and what would fix it. Acknowledge real strengths.\nSchema: {"critiques": [{"target": string (proposal id), "strengths": string[], "weaknesses": string[], "questions": string[], "severity": "low"|"medium"|"high"}]}`;
}

export function revisionPrompt(s: Session, memory: MemoryEntry[], own: Proposal, critiques: Critique[]): string {
  return `${context(s, memory)}\n\n## Your current proposal\n${fmtProposal(own)}\n\n## Critiques you received\n${critiques.map(fmtCritique).join("\n") || "(none)"}\n\nRevise your proposal. Accept valid criticism, rebut invalid criticism in the changelog, and follow any Architect instructions.\nSchema: ${PROPOSAL_SCHEMA.slice(0, -1)}, "changelog": string[]}`;
}

export function votePrompt(s: Session, memory: MemoryEntry[], proposals: Proposal[], self: string): string {
  return `${context(s, memory)}\n\n## Revised proposals\n${proposals.map(fmtProposal).join("\n\n")}\n\nScore every proposal except your own (${self}) from 1 (reject) to 10 (adopt as-is), with a one-line reason. List objections only if something would make you block ANY plan as written.\nSchema: {"scores": {"<proposal id>": {"score": number, "reason": string}}, "objections": string[]}`;
}

export function synthesisPrompt(
  s: Session,
  memory: MemoryEntry[],
  winner: Proposal,
  proposals: Proposal[],
  critiques: Critique[],
  executors: { id: string; name: string }[],
  objections: string[],
): string {
  return `${context(s, memory)}\n\n## Winning proposal\n${fmtProposal(winner)}\n\n## Other proposals\n${proposals
    .filter((p) => p.id !== winner.id)
    .map(fmtProposal)
    .join("\n\n")}\n\n## Outstanding critiques\n${critiques.map(fmtCritique).join("\n") || "(none)"}\n\n## Unresolved objections\n${
    objections.join("\n") || "(none)"
  }\n\nAs Speaker, synthesize ONE unified, executable plan. Start from the winning proposal, adopt the strongest ideas from the others, and address the critiques. Split execution into small tasks; assign each to one of these executors: ${executors
    .map((e) => `${e.id} (${e.name})`)
    .join(", ")}. Record unresolved disagreements in "dissent" instead of hiding them.\nSchema: {"title": string, "rationale": string, "tasks": [{"id": string, "title": string, "instructions": string, "executor": string, "verify": string}], "risks": string[], "dissent": string[]}`;
}

export function reviewPrompt(s: Session, task: { title: string; instructions: string }, result: TaskResult, diff: string): string {
  return `## Motion\n${s.title}\n\n## Task under review\n${task.title}\n${task.instructions}\n\n## Executor output\n${result.output.slice(
    -4000,
  )}\n\n## Diff\n${diff.slice(0, 20000) || "(no changes)"}\n\n## Tests\n${
    result.tests ? `$ ${result.tests.command}\nexit ${result.tests.exitCode}\n${result.tests.output.slice(-4000)}` : "(no test command configured)"
  }\n\nYou are the independent reviewer. Decide whether the change does what the task asked, safely.\nSchema: {"verdict": "pass"|"fail"|"concerns", "findings": string[]}`;
}
