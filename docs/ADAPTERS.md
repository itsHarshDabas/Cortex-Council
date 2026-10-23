# Coding-agent CLI adapters

Cortex Council drives four coding-agent CLIs through dedicated adapters
(`src/server/adapters/agentCli.ts`). Each one uses the tool's documented headless
interface, parses its structured output, and keeps deliberation read-only.

| Adapter `type` | Tool | Headless? | Deliberation (`complete`) | Execution (`execute`, in a worktree) | Output parsed |
|---|---|---|---|---|---|
| `opencode` | [OpenCode](https://opencode.ai) (`opencode-ai`) | yes | `opencode run --format json "<prompt>"` | same + `--auto` | NDJSON events |
| `kilo` | [Kilo Code CLI](https://kilo.ai/docs/cli) (`@kilocode/cli`) | yes | `kilo run --format json "<prompt>"` | same + `--auto` | NDJSON events (OpenCode fork) |
| `cline` | [Cline CLI](https://docs.cline.bot/cline-cli/overview) (`cline`) | yes | `cline --json --plan --auto-approve false "<prompt>"` | `cline --json --yolo --cwd <wt> "<prompt>"` | NDJSON `agent_event` / `run_result` |
| `freebuff` | [Freebuff](https://freebuff.com) (`freebuff`) | **no** | fails fast with a clear message | not offered; another executor is used | n/a |

Researched on 2026-10-23 against the docs linked above and the published npm
packages. Every flag used was checked against `--help` of the installed CLIs
(`opencode-ai` 1.19.4, `@kilocode/cli` 7.8.17, `cline` 3.0.73), and the error
streams of all three were captured from real runs and replayed in
`tests/agentCli.test.ts`. Successful runs are covered by mocked processes that
replay the documented event shapes. `freebuff` 0.2.34's package exposes no
non-interactive entry point.

## Configuration

Add members to `cortex.config.json`. Every field except `type` is optional.

```jsonc
{
  "id": "opencode", "name": "OpenCode", "roles": ["engineer", "executor"], "canExecute": true,
  "adapter": {
    "type": "opencode",              // opencode | kilo | cline | freebuff
    "model": "anthropic/claude-sonnet-4-5", // tool's own model id; omit for the tool's default
    "agent": "build",                // opencode/kilo only: named agent
    "provider": "anthropic",         // cline only: provider id
    "autoApprove": true,             // execution only (default true); deliberation never auto-approves
    "extraArgs": [],                 // inserted before the prompt
    "command": "opencode",           // override the binary (path or name)
    "timeoutMs": 900000
  }
}
```

The binary's name must be in `execution.allowedCommands` (the defaults now include
`opencode`, `kilo`, `cline` and `freebuff`). Authenticate each tool once outside
Cortex (`opencode auth login`, `kilo auth`, `cline auth`); Cortex never handles
their credentials.

`GET /api/adapters/health` runs `<cli> --version` for each member and tells you
whether the binary is missing.

## How each adapter behaves

**Safety split.** Debating members run in the server's directory, so `complete`
never grants tool approval: OpenCode/Kilo run without `--auto` (their docs say a
non-interactive run auto-rejects permission requests), and Cline runs in plan mode
with `--auto-approve false` (non-TTY approval requests are denied). Executing
members run inside the task's git worktree, where auto-approval is on by default;
set `"autoApprove": false` to turn it off.

**OpenCode and Kilo Code.** Kilo's CLI is a fork of OpenCode, so one implementation
covers both. Events parsed: `text` (`part.text`, joined as the answer),
`tool_use` (rendered as `→ bash: echo hello` in the live log), `step_finish`
(`part.tokens` summed into usage) and `error` (`error.data.message`). An `error`
event fails the run even if the process exits 0. Kilo exit code `124` is reported
as the CLI's own timeout.

**Cline.** Uses `--json`. The final answer is the `run_result` line's `text`; if
the run is cut short, streamed `agent_event` text is used instead. `--timeout` is
set a few seconds below Cortex's own limit so Cline can stop cleanly, and `--yolo`
makes it exit when the task is done.

**Long prompts.** Linux limits a single argument to 128 KiB. Prompts over 100 KB
are sent as an attached file (`--file`) to OpenCode/Kilo, and on stdin to Cline
(both documented inputs). The temp file is deleted afterwards. A prompt that
starts with `-` is prefixed with a space so it is never read as a flag.

**Freebuff.** Freebuff is an interactive terminal UI only: it has no prompt
argument, print mode or JSON output today (open requests:
[CodebuffAI/freebuff#947](https://github.com/CodebuffAI/freebuff/issues/947),
[#1322](https://github.com/CodebuffAI/freebuff/issues/1322)). Scripting its TUI
through a pseudo-terminal would be fragile and could leave half-applied edits, so
the adapter falls back cleanly instead:

- `complete` throws a clear error, so the member is marked absent and the debate
  continues with the remaining quorum.
- It has no `execute`, so if a plan assigns a task to Freebuff the executor picks
  the next member with `canExecute`.
- Health reports whether `freebuff` is installed and why it can't run headless.

You can still use Freebuff by hand in a task's worktree (`.cortex/worktrees/...`).
When Freebuff ships a print mode, opt in without a code change:

```json
{ "type": "freebuff", "args": ["--print", "{prompt}"] }
```

(The flag name above is a placeholder; use whatever Freebuff documents.) Its
plain-text stdout is then used as the answer.

## Still on the generic `cli` adapter

Claude Code, Gemini CLI, Codex and Aider keep using the generic
`{ "type": "cli", "command": ..., "args": [..., "{prompt}"] }` adapter, which
returns raw stdout.
