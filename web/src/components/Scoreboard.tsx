import { useState } from "react";
import type { MemberInfo, Session } from "../../../src/shared/types.ts";

/** Proposal comparison: scores, agreement, consensus meter and critiques per proposal. */
export function Scoreboard({ session, members }: { session: Session; members: MemberInfo[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const last = session.consensus.at(-1);
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const color = (id: string) => members.find((m) => m.id === id)?.color ?? "#94a3b8";
  const proposals = Object.values(session.proposals);
  const order = last ? last.tallies.map((t) => t.proposalId) : proposals.map((p) => p.id);
  const pct = Math.round((last?.agreement ?? 0) * 100);
  const need = Math.round(session.consensusThreshold * 100);

  return (
    <div className="panel-body">
      <section className="meter">
        <div className="meter-head">
          <span>Consensus</span>
          <b className={last?.reached ? "ok" : ""}>{last ? `${pct}%` : "—"}</b>
        </div>
        <div className="meter-bar">
          <div className="fill" style={{ width: `${pct}%` }} />
          <div className="mark" style={{ left: `${need}%` }} title={`threshold ${need}%`} />
        </div>
        <div className="rounds">
          {session.consensus.map((c) => (
            <span key={c.round + "-" + c.winner} className={c.reached ? "ok" : ""} title={`round ${c.round}`}>
              R{c.round}: {Math.round(c.agreement * 100)}%
            </span>
          ))}
        </div>
        {last && last.blockingObjections.length > 0 && (
          <ul className="objections">
            {last.blockingObjections.map((o) => (
              <li key={o}>⚑ {o}</li>
            ))}
          </ul>
        )}
      </section>

      {proposals.length === 0 && <p className="muted">Proposals appear here as members table them.</p>}
      {order.map((id) => {
        const p = session.proposals[id];
        if (!p) return null;
        const t = last?.tallies.find((x) => x.proposalId === id);
        const crit = session.critiques.filter((c) => c.target === id);
        return (
          <article key={id} className={`proposal ${last?.winner === id ? "leading" : ""}`} style={{ ["--c" as string]: color(id) }}>
            <header onClick={() => setOpen(open === id ? null : id)}>
              <span className="who">{name(id)}</span>
              {t && (
                <span className="score">
                  {t.mean.toFixed(1)}
                  <small>/10 · {Math.round(t.agreement * 100)}% agree</small>
                </span>
              )}
            </header>
            {t && (
              <div className="bar">
                <div style={{ width: `${t.mean * 10}%` }} />
              </div>
            )}
            <p>{p.summary}</p>
            {open === id && (
              <div className="detail">
                <p className="muted">{p.approach}</p>
                <ol>
                  {p.steps.map((s, i) => (
                    <li key={i}>
                      <b>{s.title}</b> — {s.detail}
                    </li>
                  ))}
                </ol>
                {p.risks.length > 0 && <p className="muted">Risks: {p.risks.join("; ")}</p>}
                {p.changelog.length > 0 && <p className="muted">Changelog: {p.changelog.join(" ")}</p>}
                {crit.length > 0 && (
                  <>
                    <h4>Critiques ({crit.length})</h4>
                    <ul className="crit">
                      {crit.slice(-6).map((c, i) => (
                        <li key={i} className={c.severity}>
                          <b>{name(c.author)}</b> R{c.round}: {c.weaknesses.join(" ") || "no weaknesses"}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
