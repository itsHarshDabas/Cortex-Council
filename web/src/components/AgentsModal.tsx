import { useEffect, useState } from "react";
import type { AgentsInfo, CliTool, CliToolPreset, CliToolStatus } from "../../../src/shared/agents.ts";
import type { Role } from "../../../src/shared/types.ts";
import { api, type CouncilInfo } from "../api.ts";

const ROLES: Role[] = ["strategist", "skeptic", "engineer", "security", "reviewer", "researcher", "speaker"];

interface Draft {
  tool: CliToolPreset;
  name: string;
  model: string;
  roles: Role[];
  persona: string;
  committees: string[];
  canExecute: boolean;
  /** Minutes per debate call; empty = server default (10). */
  timeoutMin: string;
}

/** Seat local coding-agent CLIs (Claude Code, OpenCode, Kilo, Cline, Freebuff) without editing cortex.config.json. */
export function AgentsModal({ council, onClose, onChanged }: { council: CouncilInfo; onClose: () => void; onChanged: () => void }) {
  const [info, setInfo] = useState<AgentsInfo | null>(null);
  const [found, setFound] = useState<Partial<Record<CliTool, CliToolStatus>>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([api.agents().then(setInfo), api.detectAgents().then(setFound)]).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const start = (tool: CliToolPreset) =>
    setDraft({
      tool,
      name: tool.name,
      model: "",
      roles: ["engineer"],
      persona: "",
      committees: council.committees.some((c) => c.id === "engineering") ? ["engineering"] : [],
      canExecute: tool.headless,
      timeoutMin: "",
    });

  const save = async (d: Draft) => {
    const body = {
      tool: d.tool.id,
      name: d.name || d.tool.name,
      ...(d.model ? { model: d.model } : {}),
      roles: d.roles,
      persona: d.persona || undefined,
      committees: d.committees,
      canExecute: d.canExecute,
      ...(d.timeoutMin ? { timeoutMs: Math.round(Number(d.timeoutMin) * 60_000) } : {}),
    };
    if (await run(() => api.seatAgent(body))) setDraft(null);
  };

  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const tools = info?.tools ?? [];
  const seats = info?.seats ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="CLI agents">
        <div className="row between">
          <h2>CLI agents</h2>
          <button type="button" className="link" onClick={onClose} aria-label="Close">
            close ✕
          </button>
        </div>
        <p className="muted small">
          Seat the coding agents installed on this machine. Install and sign in to each tool once in a terminal; Cortex runs it headless with
          your existing login and never sees those credentials. In debates an agent is read-only. Agents that can execute run approved tasks
          inside a git worktree.
        </p>
        {error && <div className="error">{error}</div>}

        <section className="providers">
          {tools.map((t) => {
            const status = found[t.id];
            const n = seats.filter((s) => s.tool === t.id).length;
            return (
              <div key={t.id} className="provider-row">
                <div>
                  <b>{t.name}</b>{" "}
                  <span className={`key-badge ${status ? (status.installed ? "ok" : "bad") : ""}`} title={status?.detail}>
                    {status ? (status.installed ? `${t.command} found ✓` : `${t.command} not on PATH`) : "checking…"}
                  </span>
                  {!t.headless && <span className="key-badge bad">no headless mode yet</span>}
                  {status && !status.installed && (
                    <div className="small muted">
                      Install: <code>{t.install}</code> · then sign in: <code>{t.auth}</code>
                    </div>
                  )}
                  {n > 0 && (
                    <div className="small muted">
                      {n} seat{n === 1 ? "" : "s"}
                    </div>
                  )}
                </div>
                <div className="provider-actions">
                  <a className="link small" href={t.docs} target="_blank" rel="noreferrer">
                    docs
                  </a>
                  <button type="button" disabled={busy} onClick={() => start(t)}>
                    + Seat
                  </button>
                </div>
              </div>
            );
          })}
        </section>

        {seats.length > 0 && (
          <section>
            <h3>Seated agents</h3>
            <ul className="seat-list">
              {seats.map((s) => {
                const color = council.members.find((m) => m.id === s.id)?.color;
                return (
                  <li key={s.id} style={{ ["--c" as string]: color }}>
                    <div>
                      <b>{s.name}</b> <span className="mono small muted">{s.model ?? "tool default model"}</span>
                      <div className="small muted">
                        {tools.find((t) => t.id === s.tool)?.name ?? s.tool} · {s.roles.join(", ") || "no roles"}
                        {s.canExecute ? " · can execute" : ""}
                        {s.timeoutMs ? ` · ${Math.round(s.timeoutMs / 60_000)} min limit` : ""}
                      </div>
                    </div>
                    <div className="provider-actions">
                      <button type="button" className="danger" disabled={busy} onClick={() => confirm(`Unseat ${s.name}?`) && run(() => api.unseatAgent(s.id))}>
                        Unseat
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {draft && (
          <form
            className="subform"
            onSubmit={(e) => {
              e.preventDefault();
              save(draft);
            }}
          >
            <h3>Seat {draft.tool.name}</h3>
            {!draft.tool.headless && (
              <p className="small muted">
                Freebuff is an interactive terminal app with no headless mode yet, so it will sit out debates and never execute. Seat it now and
                it starts working once Freebuff ships a print mode (see docs/ADAPTERS.md).
              </p>
            )}
            <div className="row">
              <label>
                Seat name
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} />
              </label>
              <label>
                Model (optional)
                <input
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  className="mono"
                  placeholder={draft.tool.modelHint ? `tool default, e.g. ${draft.tool.modelHint}` : "tool default"}
                  disabled={!draft.tool.headless}
                />
              </label>
              <label>
                Debate time limit (min)
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={draft.timeoutMin}
                  onChange={(e) => setDraft({ ...draft, timeoutMin: e.target.value })}
                  placeholder="10"
                  title="How long each proposal, critique, revision or vote may take before the seat is marked absent"
                />
              </label>
            </div>
            <label className="row">
              <input
                type="checkbox"
                checked={draft.canExecute}
                disabled={!draft.tool.headless}
                onChange={(e) => setDraft({ ...draft, canExecute: e.target.checked })}
              />
              Can execute approved tasks (in a git worktree, with the tool's auto-approve)
            </label>
            <div className="field-label">Debate roles</div>
            <div className="checks">
              {ROLES.map((r) => (
                <label key={r}>
                  <input type="checkbox" checked={draft.roles.includes(r)} onChange={(e) => setDraft({ ...draft, roles: toggle(draft.roles, r, e.target.checked) })} />
                  {r}
                </label>
              ))}
            </div>
            {council.committees.length > 0 && (
              <>
                <div className="field-label">Committees</div>
                <div className="checks">
                  {council.committees.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={draft.committees.includes(c.id)}
                        onChange={(e) => setDraft({ ...draft, committees: toggle(draft.committees, c.id, e.target.checked) })}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </>
            )}
            <label>
              Persona (optional)
              <textarea value={draft.persona} onChange={(e) => setDraft({ ...draft, persona: e.target.value })} rows={2} maxLength={1000} placeholder="How this member should argue" />
            </label>
            <footer>
              <button type="button" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy}>
                Seat member
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
