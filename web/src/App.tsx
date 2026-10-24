import { useEffect, useState } from "react";
import type { SessionSummary } from "../../src/shared/types.ts";
import { api, ApiError, setToken, type CouncilInfo } from "./api.ts";
import { AgentsModal } from "./components/AgentsModal.tsx";
import { ArchitectConsole } from "./components/ArchitectConsole.tsx";
import { AuditPanel } from "./components/AuditPanel.tsx";
import { ChamberFeed } from "./components/ChamberFeed.tsx";
import { ExecutionPanel } from "./components/ExecutionPanel.tsx";
import { Hemicycle } from "./components/Hemicycle.tsx";
import { MemoryPanel } from "./components/MemoryPanel.tsx";
import { NewMotion } from "./components/NewMotion.tsx";
import { PhaseTimeline } from "./components/PhaseTimeline.tsx";
import { PlanPanel } from "./components/PlanPanel.tsx";
import { ProvidersModal } from "./components/ProvidersModal.tsx";
import { Scoreboard } from "./components/Scoreboard.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { ConfirmHost, confirmDialog, Icon, statusLabel } from "./components/ui.tsx";
import { usePoll, useSession } from "./hooks.ts";

type Tab = "debate" | "plan" | "execution" | "audit" | "memory";
const TABS: { id: Tab; label: string }[] = [
  { id: "debate", label: "Proposals" },
  { id: "plan", label: "Plan" },
  { id: "execution", label: "Execution" },
  { id: "audit", label: "Audit" },
  { id: "memory", label: "Memory" },
];
const RUNNING = new Set(["deliberating", "paused", "executing"]);

export function App() {
  const [council, setCouncil] = useState<CouncilInfo | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("session"));
  const [showNew, setShowNew] = useState(false);
  const [showProviders, setShowProviders] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [councilVersion, setCouncilVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("debate");
  const [toast, setToast] = useState<string | null>(null);
  const { session, events, thinking, live } = useSession(selected);
  const sessions = usePoll<SessionSummary[]>(() => api.sessions(), [session?.status], 0);
  const health = usePoll(() => api.health(), [council], 0);

  useEffect(() => {
    api
      .council()
      .then(setCouncil)
      .catch((e) => (e instanceof ApiError && e.status === 401 ? setNeedToken(true) : setToast(e.message)));
  }, [needToken, councilVersion]);

  useEffect(() => {
    if (!selected && sessions.data?.[0]) setSelected(sessions.data[0].id);
  }, [sessions.data, selected]);

  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set("session", selected);
    history.replaceState(null, "", url);
  }, [selected]);

  // Jump to the tab that needs the Architect's attention.
  useEffect(() => {
    if (session?.status === "awaiting_approval") setTab("plan");
    if (session?.status === "executing") setTab("execution");
  }, [session?.status]);

  const deleteSession = async (s: Pick<SessionSummary, "id" | "title" | "status">) => {
    const ok = await confirmDialog({
      title: "Delete this debate?",
      body: (
        <>
          <p>
            <b>{s.title}</b> and its proposals, plan and worktrees will be removed from this machine. This can't be undone.
          </p>
          {s.status === "awaiting_approval" && <p>Its plan is still waiting for approval and will be discarded.</p>}
          <p className="small">The audit log keeps its entries, so the hash chain stays intact.</p>
        </>
      ),
      confirmLabel: "Delete debate",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteSession(s.id);
      if (selected === s.id) setSelected(sessions.data?.find((x) => x.id !== s.id)?.id ?? null);
      sessions.reload();
    } catch (e) {
      setToast((e as Error).message);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  if (needToken) {
    return (
      <div className="token-gate">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setToken(new FormData(e.currentTarget).get("token") as string);
            setNeedToken(false);
          }}
        >
          <div className="brand">
            <span className="logo" aria-hidden="true" /> Cortex Council
          </div>
          <p className="muted">This council requires an access token (CORTEX_TOKEN).</p>
          <input name="token" type="password" placeholder="Access token" autoFocus />
          <button type="submit" className="primary">
            Continue
          </button>
        </form>
      </div>
    );
  }

  const members = council?.members ?? [];
  const lastEvent = [...events].reverse().find((e) => e.type !== "task.output" && e.type !== "session.status") ?? null;
  const awaiting = session?.status === "awaiting_approval";
  const quorum = members.length >= 2;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true" /> Cortex Council
        </div>
        <div className="topbar-mid">
          {session && (
            <>
              <span className="divider-v" aria-hidden="true" />
              <span className="session-title">{session.title}</span>
              <span className={`status-pill ${session.status}`}>{statusLabel(session.status)}</span>
            </>
          )}
        </div>
        <div className="topbar-right">
          <span className={`live ${live ? "on" : ""}`} title={live ? "Live stream connected" : "Stream disconnected"}>
            <span className="live-dot" aria-hidden="true" />
            {live ? "Live" : "Offline"}
          </span>
          {session && (
            <button
              type="button"
              className="ghost"
              onClick={() => deleteSession(session)}
              disabled={RUNNING.has(session.status)}
              title={RUNNING.has(session.status) ? "Abort the debate before deleting it" : undefined}
            >
              <Icon name="trash" /> Delete
            </button>
          )}
          <button
            type="button"
            className="primary"
            onClick={() => setShowNew(true)}
            disabled={!council || !quorum}
            title={quorum ? undefined : "Add at least two members first"}
          >
            <Icon name="plus" /> New debate
          </button>
        </div>
      </header>

      <aside className="left">
        <section className="side-section">
          <h2>Debates</h2>
          <SessionList sessions={sessions.data ?? []} selected={selected} onSelect={setSelected} onDelete={deleteSession} />
        </section>
        <section className="side-section">
          <h2>Members</h2>
          {council && members.length === 0 && (
            <p className="muted small empty-note">No members yet. Add a local CLI agent (Claude Code, OpenCode, Kilo, Cline) or an API model to get started.</p>
          )}
          <ul className="roster">
            {members.map((m) => {
              const h = health.data?.[m.id];
              return (
                <li key={m.id} style={{ ["--c" as string]: m.color }}>
                  <span className="avatar" aria-hidden="true">
                    {m.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="roster-text">
                    <b>{m.name}</b>
                    <small>
                      {m.tool ?? m.provider ?? m.adapter}
                      {m.model ? ` · ${m.model}` : ""}
                      {m.canExecute ? " · exec" : ""}
                    </small>
                  </span>
                  <span className={`health ${h ? (h.ok ? "ok" : "bad") : ""}`} title={h ? (h.ok ? "Reachable" : h.detail) : "Checking…"} />
                </li>
              );
            })}
          </ul>
          <div className="member-actions">
            <button type="button" className="sm" onClick={() => setShowAgents(true)} disabled={!council} title="Add local coding-agent CLIs">
              <Icon name="plus" size={14} /> CLI agent
            </button>
            <button type="button" className="sm" onClick={() => setShowProviders(true)} disabled={!council} title="Add API providers and models">
              <Icon name="plus" size={14} /> API model
            </button>
          </div>
        </section>
      </aside>

      <main className="chamber">
        <Hemicycle members={members} session={session} thinking={thinking} lastEvent={lastEvent} />
        <PhaseTimeline session={session} />
        <ChamberFeed events={events} members={members} />
        {session && <ArchitectConsole session={session} onError={setToast} />}
      </main>

      <section className="right">
        <nav className="tabs" role="tablist" aria-label="Session details">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "plan" && awaiting && <span className="badge" aria-label="needs approval" />}
            </button>
          ))}
        </nav>
        {!session && tab !== "memory" ? (
          <div className="panel-body welcome">
            <h3>Start a debate</h3>
            <p className="muted">Describe a task and your models will propose, critique, revise and vote, then hand you one plan to approve.</p>
            {council && !quorum ? (
              <>
                <p className="muted">
                  Add at least two members first: local coding agents, API models (OpenAI, Gemini, Anthropic, OpenRouter…) or a local model through
                  Ollama or LM Studio.
                </p>
                <div className="row">
                  <button type="button" className="primary" onClick={() => setShowAgents(true)}>
                    <Icon name="plus" /> CLI agent
                  </button>
                  <button type="button" onClick={() => setShowProviders(true)}>
                    <Icon name="plus" /> API model
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="primary" onClick={() => setShowNew(true)} disabled={!council}>
                <Icon name="plus" /> New debate
              </button>
            )}
          </div>
        ) : tab === "debate" && session ? (
          <Scoreboard session={session} members={members} />
        ) : tab === "plan" && session ? (
          <PlanPanel session={session} members={members} onError={setToast} />
        ) : tab === "execution" && session ? (
          <ExecutionPanel session={session} events={events} members={members} />
        ) : tab === "audit" && session ? (
          <AuditPanel sessionId={session.id} version={events.length} />
        ) : (
          <MemoryPanel version={session?.status === "executing" ? 1 : 0} />
        )}
      </section>

      {showNew && council && (
        <NewMotion
          council={council}
          onClose={() => setShowNew(false)}
          onCreated={(s) => {
            setShowNew(false);
            setSelected(s.id);
            setTab("debate");
            sessions.reload();
          }}
        />
      )}
      {showProviders && council && (
        <ProvidersModal council={council} onClose={() => setShowProviders(false)} onChanged={() => setCouncilVersion((v) => v + 1)} />
      )}
      {showAgents && council && (
        <AgentsModal council={council} onClose={() => setShowAgents(false)} onChanged={() => setCouncilVersion((v) => v + 1)} />
      )}
      {toast && (
        <div className="toast" role="alert">
          <span>{toast}</span>
          <button type="button" className="ghost icon-only sm" onClick={() => setToast(null)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      <ConfirmHost />
    </div>
  );
}
