import { useEffect, useState } from "react";
import type { SessionSummary } from "../../src/shared/types.ts";
import { api, ApiError, setToken, type CouncilInfo } from "./api.ts";
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
import { usePoll, useSession } from "./hooks.ts";

type Tab = "debate" | "plan" | "execution" | "audit" | "memory";

export function App() {
  const [council, setCouncil] = useState<CouncilInfo | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("session"));
  const [showNew, setShowNew] = useState(false);
  const [showProviders, setShowProviders] = useState(false);
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
          <h1>◆ Cortex Council</h1>
          <p className="muted">This council requires an access token (CORTEX_TOKEN).</p>
          <input name="token" type="password" placeholder="Access token" autoFocus />
          <button className="primary">Enter chamber</button>
        </form>
      </div>
    );
  }

  const members = council?.members ?? [];
  const lastEvent = [...events].reverse().find((e) => e.type !== "task.output" && e.type !== "session.status") ?? null;
  const awaiting = session?.status === "awaiting_approval";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> CORTEX <span>COUNCIL</span>
        </div>
        <div className="topbar-mid">
          {session && (
            <>
              <span className={`status-pill ${session.status}`}>{session.status.replace("_", " ")}</span>
              <span className="session-title">{session.title}</span>
            </>
          )}
        </div>
        <div className="topbar-right">
          <span className={`live ${live ? "on" : ""}`} title={live ? "Live stream connected" : "Stream disconnected"}>
            ● {live ? "LIVE" : "OFFLINE"}
          </span>
          <button className="primary" onClick={() => setShowNew(true)} disabled={!council}>
            + New motion
          </button>
        </div>
      </header>

      <aside className="left">
        <h2>Motions</h2>
        <SessionList sessions={sessions.data ?? []} selected={selected} onSelect={setSelected} />
        <div className="row between">
          <h2>Members</h2>
          <button className="link small" onClick={() => setShowProviders(true)} disabled={!council} title="Add API providers and models">
            + API providers
          </button>
        </div>
        <ul className="roster">
          {members.map((m) => {
            const h = health.data?.[m.id];
            return (
              <li key={m.id} style={{ ["--c" as string]: m.color }}>
                <span className={`health ${h ? (h.ok ? "ok" : "bad") : ""}`} title={h?.detail} />
                <b>{m.name}</b>
                <small>
                  {m.provider ?? m.adapter}
                  {m.model ? ` · ${m.model}` : ""}
                  {m.canExecute ? " · exec" : ""}
                </small>
              </li>
            );
          })}
        </ul>
      </aside>

      <main className="chamber">
        <Hemicycle members={members} session={session} thinking={thinking} lastEvent={lastEvent} />
        <PhaseTimeline session={session} />
        <ChamberFeed events={events} members={members} />
        {session && <ArchitectConsole session={session} onError={setToast} />}
      </main>

      <section className="right">
        <nav className="tabs">
          {(["debate", "plan", "execution", "audit", "memory"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "debate" ? "Proposals" : t[0]!.toUpperCase() + t.slice(1)}
              {t === "plan" && awaiting && <span className="badge">!</span>}
            </button>
          ))}
        </nav>
        {!session && tab !== "memory" ? (
          <div className="panel-body welcome">
            <h3>Welcome, Architect.</h3>
            <p>Table a motion and the council will propose, cross-examine, revise and vote, then present one plan for your approval.</p>
            <button className="primary" onClick={() => setShowNew(true)} disabled={!council}>
              + New motion
            </button>
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
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
