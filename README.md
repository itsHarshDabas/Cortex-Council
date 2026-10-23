# ◆ Cortex Council

**An AI parliament.** Models deliberate, cross-examine each other and converge on one
evidence-backed plan. Tools execute it only after you, the **Architect**, approve.
Independent reviewers verify the result, and every step lands in a tamper-evident audit log.

```
 Motion ─► Propose ─► Critique ─► Revise ─► Vote ──(no consensus)──┐
                         ▲                                         │
                         └─────────────────────────────────────────┘
                                         │ consensus / max rounds
                                         ▼
           Synthesize (Speaker) ─► ◆ ARCHITECT APPROVAL GATE ◆ ─► Execute in git worktrees
                                     approve · amend · reject       ─► Tests ─► Independent review ─► Report
```

Runs fully offline out of the box: the default council is five mock members, so you can
watch the whole loop without a single API key. Swap in real models with one config file.

## Quick start

```bash
git clone https://github.com/itsHarshDabas/Cortex-Council && cd Cortex-Council
npm install
npm run build      # build the UI
npm start          # → http://127.0.0.1:7420
```

For development (hot reload for server and UI): `npm run dev`, then open http://localhost:5173.

Requirements: Node 22+, git.

## What you can do

| As the Architect you can… | How |
|---|---|
| Table a motion | **+ New motion** → title, task, committee or hand-picked members, rounds, consensus threshold |
| Watch the debate live | Hemicycle shows who is thinking and who is critiquing whom; the chamber feed streams every proposal, critique, vote and consensus calculation |
| Intervene at any time | Type in the **ARCHITECT ›** console. Interjections are binding and injected into every later prompt |
| Pause, resume, abort | Console buttons. Checked before every model call |
| Compare proposals | **Proposals** tab: score per proposal, agreement, consensus meter vs threshold, objections, critiques received |
| Approve, amend or reject | **Plan** tab. Amend sends the plan back for revision and a fresh vote |
| Monitor execution | **Execution** tab: branch and worktree per task, diff stat, live executor output, test result, reviewer verdict |
| Audit everything | **Audit** tab: hash-chained log with one-click chain verification |
| Curate shared memory | **Memory** tab. Approved plans are saved automatically and recalled into future debates |

## How the deliberation works

1. **Propose (blind).** Every member drafts a proposal without seeing the others.
2. **Critique.** Every member critiques every other proposal: strengths, weaknesses, questions, severity.
3. **Revise.** Authors revise under the critiques aimed at them, with a changelog.
4. **Vote.** Every member scores every proposal 1–10. Self-votes are ignored.
5. **Consensus.** Winner = highest mean. Agreement = 1 − (stdev / 4.5). Consensus needs agreement ≥ threshold,
   a mean ≥ 6, and no blocking objections. Otherwise steps 2–4 repeat, up to `maxRounds`.
6. **Synthesize.** The Speaker merges the winner with the best ideas and critiques into one plan of small
   tasks, each assigned to an executor. Unresolved disagreement is kept as **dissent**, never hidden.
7. **Approval gate.** The session halts. Nothing runs until you approve.
8. **Execute → verify → review.** Each task runs in its own `git worktree` on branch
   `cortex/<session>/<task>`, then your test command runs there, then a reviewer that is *not* the
   executor audits the diff and test output.

Fault tolerance: per-call timeouts and retries; a member that keeps failing is marked absent and the
debate continues while a quorum of 2 remains; if the Speaker fails, the plan is built from the winning
proposal; a server restart keeps sessions that were waiting for approval.

## Adding API providers from the UI

Click **+ API providers** next to *Members*. Pick a preset (OpenAI, Anthropic, Gemini, OpenRouter, Groq,
DeepSeek, Mistral, xAI, Together, Ollama, LM Studio) or **Custom endpoint** for any OpenAI-compatible URL.
**Test connection** lists the provider's models, which checks the URL and key and fills the model picker.
Then **Seat model**: pick the model, a name, roles and committees. The member joins the council at once,
with no restart. Edit or unseat members and rotate keys the same way.

Keys are write-only:

- **Environment variable (recommended):** you give Cortex a name like `GROQ_API_KEY`, and the key never touches disk.
  Put it in `.env` and restart.
- **Paste key:** stored in `<dataDir>/secrets.json` with owner-only permissions (0600), next to a `.gitignore`
  that keeps the whole data dir out of git. It is never returned by the API, written to the audit log or
  shown in events, and it is deleted when you remove the provider or switch it to an env var.
  On Windows the file permissions are not enforced, so prefer env vars there.

UI-managed providers and seats live in `<dataDir>/providers.json`. A member in `cortex.config.json` can
use one too: `{ "type": "provider", "provider": "groq", "model": "llama-3.3-70b-versatile" }`. API seats
debate but never execute; seat a CLI agent as the executor.

## Connecting real models and agents

Copy `cortex.config.example.json` to `cortex.config.json` and edit. API keys are referenced by env var
name and never stored in config; put them in `.env` (see `.env.example`).

| Adapter | Covers | Example |
|---|---|---|
| `openai` | ChatGPT/OpenAI, **Ollama**, LM Studio, vLLM, OpenRouter, Groq — anything OpenAI-compatible | `{ "type": "openai", "model": "gpt-5", "apiKeyEnv": "OPENAI_API_KEY" }` / `{ "type": "openai", "baseUrl": "http://localhost:11434/v1", "model": "llama3.1:8b" }` |
| `anthropic` | Claude models | `{ "type": "anthropic", "model": "claude-opus-5-5" }` |
| `gemini` | Google Gemini | `{ "type": "gemini", "model": "gemini-2.5-pro" }` |
| `opencode` / `kilo` / `cline` | Dedicated coding-agent adapters: **OpenCode**, **Kilo Code**, **Cline** (JSON output parsed, read-only while debating, auto-approve only in worktrees) | `{ "type": "cline", "provider": "anthropic" }` / `{ "type": "kilo", "model": "anthropic/claude-sonnet-4-5" }` |
| `freebuff` | **Freebuff** (interactive-only today: fails fast and never executes, see [docs/ADAPTERS.md](docs/ADAPTERS.md)) | `{ "type": "freebuff" }` |
| `cli` | Any other headless agent CLI: **Claude Code**, Gemini CLI, Codex, Aider | `{ "type": "cli", "command": "claude", "args": ["-p", "{prompt}", "--permission-mode", "acceptEdits"] }` |
| `mock` | Offline, deterministic | `{ "type": "mock", "latencyMs": 900 }` |

Members with `"canExecute": true` and a `cli`, `opencode`, `kilo`, `cline` (or `mock`) adapter can run approved tasks. Set
`execution.workspace` to the git repo they should work in; without it, a sandbox repo is created in
`.cortex/sandbox`. Set `execution.testCommand` (e.g. `["npm", "test"]`) to gate tasks on your tests.

Adding a provider is one file implementing `ModelAdapter` in `src/server/adapters/` plus a case in
`registry.ts`.

> Flags, output formats and fallbacks for each coding-agent CLI are documented in
> [docs/ADAPTERS.md](docs/ADAPTERS.md). Antigravity has no headless interface yet and is planned via the MCP
> bridge (milestone M5); Hermes can join through the `openai` adapter if it exposes an OpenAI-compatible API.

## Security model

- Binds to `127.0.0.1`. Binding elsewhere requires `CORTEX_TOKEN` (bearer auth for API and UI).
- Host and Origin checks plus JSON-only writes protect the local API from DNS rebinding and CSRF.
- Execution only after a recorded approval; each task is isolated in its own worktree and branch.
  Nothing is merged or pushed for you.
- Commands are spawned without a shell from an allowlist (`execution.allowedCommands`); model output is
  only ever passed as a single argument, never interpreted.
- API keys come from env, or from an owner-only `secrets.json` when pasted in the UI. Either way they are
  write-only over the API and redacted from the audit log and live events.
- Audit log is append-only and hash-chained; `GET /api/audit/verify` detects edits, deletions and reordering.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/council` | members, committees, defaults |
| GET | `/api/adapters/health` | per-member adapter health |
| GET/POST | `/api/providers` | list providers, seats and presets / add a provider (`{name, kind, baseUrl?, keySource, apiKeyEnv?, apiKey?}`) |
| PUT/DELETE | `/api/providers/:id` | edit (omit `apiKey` to keep the stored key) / remove (409 while members are seated) |
| POST | `/api/providers/test` | list models for a draft or saved (`{id}`) provider |
| POST | `/api/seats` | seat a model (`{name, provider, model, roles, committees?, persona?, temperature?, maxTokens?}`) |
| PUT/DELETE | `/api/seats/:id` | edit / unseat a UI-managed member |
| GET/POST | `/api/sessions` | list / create (`{title, task, committee?, members?, maxRounds?, consensusThreshold?}`) |
| GET | `/api/sessions/:id` | full session state |
| POST | `/api/sessions/:id/{interject,pause,resume,abort}` | Architect controls |
| POST | `/api/sessions/:id/{approve,amend,reject}` | approval gate |
| GET | `/api/stream?session=:id` | Server-Sent Events (history replay, then live) |
| GET | `/api/audit`, `/api/audit/verify` | audit log and chain verification |
| GET/POST/DELETE | `/api/memory` | shared project memory |

## Project layout

```
src/shared/types.ts          types shared by server and UI
src/server/adapters/         mock, openai, anthropic, gemini, cli, agentCli (opencode/kilo/cline/freebuff) + registry
src/server/orchestrator/     protocol state machine, consensus maths, prompts, session manager
src/server/execution/        allowlisted runner, git worktrees, execution + review service
src/server/core/             event bus, hash-chained audit log, session store, project memory
src/server/http/             node:http API + SSE
web/                         React UI (Vite)
tests/                       Vitest suite (protocol, gate, worktrees, audit, API, security)
docs/PLAN.md                 architecture, MVP scope and roadmap
```

## Development

```bash
npm test           # 39 tests, ~3s, no network
npm run typecheck
npm run dev
```

## Roadmap

Token streaming and cost caps, learned routing, parallel worktrees with a task graph, MCP bridge,
embeddings-based memory, packaging. See [docs/PLAN.md](docs/PLAN.md).
