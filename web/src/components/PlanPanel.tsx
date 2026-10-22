import { useState } from "react";
import type { MemberInfo, Session } from "../../../src/shared/types.ts";
import { api } from "../api.ts";

/** The unified plan and the Architect's approval gate. */
export function PlanPanel({ session, members, onError }: { session: Session; members: MemberInfo[]; onError: (m: string) => void }) {
  const [amend, setAmend] = useState("");
  const [busy, setBusy] = useState(false);
  const plan = session.plan;
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const gate = session.status === "awaiting_approval";
  const act = async (p: Promise<unknown>) => {
    setBusy(true);
    try {
      await p;
      setAmend("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!plan) return <div className="panel-body muted">The Speaker will present a unified plan once the debate concludes.</div>;
  return (
    <div className="panel-body">
      {gate && <div className="gate-banner">◆ Awaiting your approval. Nothing executes until you decide.</div>}
      <h3>{plan.title}</h3>
      <p className="muted">{plan.rationale}</p>
      <h4>Tasks</h4>
      <ol className="tasks">
        {plan.tasks.map((t) => (
          <li key={t.id}>
            <div>
              <b>{t.title}</b> <span className="chip">{name(t.executor)}</span>
            </div>
            <p>{t.instructions}</p>
            {t.verify && <p className="muted small">Verify: {t.verify}</p>}
          </li>
        ))}
      </ol>
      {plan.risks.length > 0 && (
        <>
          <h4>Risks</h4>
          <ul>
            {plan.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {plan.dissent.length > 0 && (
        <>
          <h4>Dissent on record</h4>
          <ul className="dissent">
            {plan.dissent.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </>
      )}
      {gate && (
        <div className="gate">
          <textarea value={amend} onChange={(e) => setAmend(e.target.value)} placeholder="Amendment: send the plan back with new instructions…" rows={3} />
          <div className="gate-actions">
            <button className="primary" disabled={busy} onClick={() => act(api.approve(session.id))}>
              ✓ Approve &amp; execute
            </button>
            <button disabled={busy || !amend.trim()} onClick={() => act(api.amend(session.id, amend))}>
              ↺ Amend
            </button>
            <button className="danger" disabled={busy} onClick={() => act(api.reject(session.id, amend || undefined))}>
              ✕ Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
