# Cortex Council — Plan

> An AI parliament: models deliberate, critique each other and converge on one
> evidence-backed plan; tools execute it only after the Architect (you) approves;
> independent reviewers verify the result. Everything is logged.

This document is the plan written **before** any code. It defines the MVP, the
architecture, and the milestones after it. Decisions marked **(D)** are
deliberate choices with the reasoning next to them, so they can be revisited.

---

## 1. Goals and non-goals

### MVP goals
1. **Runs with zero keys.** A deterministic mock adapter lets the whole debate →
   approval → execution → verification loop run offline (demo, tests, CI).
2. **Real deliberation, not parallel monologues.** Members propose
   independently, read and critique each other's proposals, revise, score every
   proposal, and a Speaker synthesizes the winner plus the accepted critiques
   into one structured plan.
3. **Architect stays in control.** Live view of every message, interjections at
   any time, pause / resume / abort, and a hard approval gate before anything
   executes. Approve, reject, or send back with amendments.
4. **Pluggable adapters.** One small interface for every model or CLI:
   OpenAI-compatible (ChatGPT, Ollama, LM Studio, OpenRouter, vLLM…), Anthropic,
   Gemini, and a generic CLI adapter (Claude Code, OpenCode, Gemini CLI,
   Aider, etc.). Adding a provider = one file.
5. **Safe execution.** Each approved task runs in its own **git worktree** on its
   own branch; commands are spawned without a shell, from an allowlist, with
   timeouts. Then the test command runs and a reviewer member audits the diff.
6. **Audit trail.** Append-only, hash-chained JSONL log of every event. Tamper
   detection via `verify`.
7. **Shared memory.** Approved decisions are saved and fed into future
   deliberations as context.
8. **Local-first and private.** Binds to `127.0.0.1`, optional bearer token, data
   lives in `./.cortex/`, secrets come from env and are redacted from logs.

### Non-goals for the MVP
- Multi-user accounts, cloud hosting, RBAC.
- Driving IDE-embedded agents (Cline, Kilo Code, Antigravity) directly. They have
  no stable headless API; they plug in later via MCP or their CLIs (see §8).
- Automatic merging of executed work. The MVP stops at "branch ready + report".

---

## 2. Architecture

```
┌──────────────────────── Web UI (React + Vite) ─────────────────────────┐
│ Hemicycle (members, live speaker) · Chamber feed · Proposal scoreboard │
│ Consensus meter · Approval gate · Execution monitor · Audit · Memory   │
└───────────────▲ SSE (events) ───────────────────── REST (commands) ────┘
                │                                     │
┌───────────────┴─────────────── Server (Node 22, TS) ▼──────────────────┐
│ HTTP API (node:http, no framework)  ── auth token, localhost bind      │
│                                                                        │
│  SessionManager ── Orchestrator (state machine per motion)             │
│        │             propose → critique → revise → vote → synthesize   │
│        │             → AWAITING_APPROVAL → execute → verify → report   │
│        │                                                               │
│  EventBus ──► SSE clients                                              │
│        ├────► AuditLog  (hash-chained JSONL)                           │
│        └────► SessionStore (JSON snapshots, resumable view)            │
│                                                                        │
│  Router (role/committee → members)   Memory (decisions JSON)           │
│                                                                        │
│  Adapter registry                    Executor                          │
│   ├ mock         (offline)            ├ WorktreeManager (git worktree) │
│   ├ openai-compat (GPT, Ollama, ...)  ├ CLI runner (allowlist, no sh)  │
│   ├ anthropic                         └ Verifier (tests + reviewer)    │
│   ├ gemini                                                             │
│   └ cli (claude, opencode, ...)                                        │
└────────────────────────────────────────────────────────────────────────┘
```

**(D) Stack: TypeScript end to end, Node 22, React + Vite, Vitest.** One
language for server, UI and shared types; Node's `fetch`, `child_process` and
`http` cover every adapter without SDKs, so the dependency tree stays tiny
(fewer supply-chain risks, faster installs).

**(D) No web framework, SSE instead of WebSockets.** The server needs ~15
routes and one-way streaming. `node:http` + Server-Sent Events gives automatic
reconnection, works through proxies, and needs no extra dependency. Commands
from the Architect go over plain REST.

**(D) Storage: files, not a database.** JSONL for the audit log, JSON for
sessions and memory, under `./.cortex/`. Zero native modules, trivially
inspectable, easy to back up. SQLite is a drop-in later if volume grows.

### 2.1 Adapter interface

```ts
interface ModelAdapter {
  readonly kind: string;                    // "mock" | "openai" | ...
  complete(req: CompletionRequest): Promise<CompletionResult>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

A **member** (seat in the parliament) = adapter + model + persona/role.
Members are declared in `cortex.config.json`; API keys are referenced by env
var name, never stored in config.

### 2.2 Deliberation protocol

| Phase | Who | Output (JSON) |
|---|---|---|
| 1. Propose | every member, in parallel, blind | `{summary, approach, steps[], risks[], confidence}` |
| 2. Critique | every member reviews every *other* proposal | `{target, strengths[], weaknesses[], questions[], severity}` |
| 3. Revise | each author, given critiques aimed at them + Architect interjections | revised proposal + `changelog[]` |
| 4. Vote | every member scores every revised proposal 1–10 with a reason | `{scores: {[id]: {score, reason}}, objections[]}` |
| 5. Consensus | orchestrator | mean score, agreement (1 − normalized stdev), blocking objections |
| 6. Synthesize | the Speaker (configurable) | unified plan: `{title, rationale, tasks[{id, title, instructions, executor, verify}], risks[], dissent[]}` |

If agreement is below the threshold and rounds remain, phases 2–4 repeat on the
revised proposals. Dissent is never discarded: it is carried into the final
plan so the Architect sees what was contested.

Members cannot vote for their own proposal (self-scores are ignored), which
removes the most obvious bias.

**Robustness:** model output is parsed from the first JSON object / fenced
block; on parse failure the raw text is kept and a fallback structure is
built, so one misbehaving model never stalls the chamber. Each call has a
timeout and retries with backoff; a member that keeps failing is marked
**absent** for that phase and the session continues while quorum (≥ 2) holds.

### 2.3 Architect controls
- **Interject** at any time → stored and injected into every later prompt.
- **Pause / resume / abort** → checked between every model call.
- **Approval gate** → session halts in `awaiting_approval`. `approve`,
  `reject`, or `amend` (re-runs revision → vote → synthesis with the amendment).
- Nothing in the execution stage can start without an `approve` event recorded
  in the audit log.

### 2.4 Execution and verification
1. For each task, `WorktreeManager` creates `git worktree add -b cortex/<session>/<task>`
   in the configured workspace repo (skipped in pure-mock mode).
2. The task's executor (a CLI member such as Claude Code, or the mock executor)
   runs inside that worktree. Spawned with an argument array (no shell), env
   allowlist, timeout, output captured and streamed.
3. `verify` command (e.g. `npm test`) runs in the worktree; exit code recorded.
4. A **reviewer** member (different from the executor) gets the diff + test
   output and returns `{verdict: pass|fail|concerns, findings[]}`.
5. Final report: per task branch, diff stats, test result, review verdict.

### 2.5 Security model
- Bind `127.0.0.1` by default; `CORTEX_TOKEN` enables bearer auth on every route.
- Executables must be on `execution.allowedCommands`; no shell interpolation.
- Execution only after a recorded approval; worktrees isolate changes from the
  main checkout.
- Secrets read from env, redacted from logs and events.
- Model output is treated as untrusted data: it never becomes a command except
  via the approved plan, and CLI executors receive it as a prompt argument.

---

## 3. MVP scope (delivered in the first PR)

- [x] Plan (this doc)
- [x] Shared types, config loader with validation and sane defaults
- [x] Adapters: mock, openai-compatible, anthropic, gemini, cli
- [x] Orchestrator with the full protocol, consensus maths, interjections,
      pause/resume/abort, approval gate, amendments
- [x] Event bus, hash-chained audit log with verify, session store, memory
- [x] Executor: git worktrees, allowlisted CLI runner, verifier, reviewer
- [x] HTTP API + SSE, optional token auth
- [x] Futuristic UI: hemicycle, live chamber, scoreboard, consensus meter,
      approval gate, execution monitor, audit view, new-motion form
- [x] Tests: consensus, JSON parsing, audit chain + tamper detection,
      orchestrator end-to-end with mock, approval gating, API smoke test
- [x] README with quick start and adapter config examples; CI workflow

## 4. Milestones after the MVP

| # | Milestone | Content |
|---|---|---|
| M2 | Streaming + cost | token streaming into the chamber, per-member token/cost meter, budget caps |
| M3 | Smarter routing | task classifier → committee; learn member weights from past review verdicts |
| M4 | Parallel coding | dependency graph between tasks, parallel worktrees, auto-rebase, PR creation |
| M5 | MCP bridge | expose the council as an MCP server, consume MCP tools; reach IDE agents (Cline, Kilo Code) |
| M6 | Memory v2 | embeddings-based retrieval over past sessions and repo docs |
| M7 | Packaging | single binary / Docker image, desktop wrapper |

## 5. Risks

| Risk | Mitigation |
|---|---|
| Models return malformed JSON | lenient parser + fallback structure + raw text kept |
| Echo-chamber consensus | blind first round, no self-votes, dissent preserved, skeptic persona |
| Runaway cost / time | rounds cap, per-call timeout, abort, mock by default |
| Destructive execution | approval gate, worktree isolation, allowlist, no shell |
| CLI tools change flags | CLI adapter is pure config (command + args template) |
