import type { CouncilEvent, MemberInfo, Session } from "../../../src/shared/types.ts";

export function ExecutionPanel({ session, events, members }: { session: Session; events: CouncilEvent[]; members: MemberInfo[] }) {
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const plan = session.plan;
  if (!plan || session.results.length === 0) {
    return <div className="panel-body muted">Execution starts after you approve the plan. Each task runs in its own git worktree.</div>;
  }
  const output = (taskId: string) =>
    events
      .filter((e) => e.type === "task.output" && (e.data as { taskId?: string })?.taskId === taskId)
      .map((e) => e.text)
      .join("");

  return (
    <div className="panel-body">
      {plan.tasks.map((t) => {
        const r = session.results.find((x) => x.taskId === t.id);
        const status = r?.status ?? "pending";
        const out = output(t.id) || r?.output;
        return (
          <article key={t.id} className={`task ${status}`}>
            <header>
              <span className={`status-chip ${status}`}>{status}</span>
              <b>{t.title}</b>
              <span className="chip">{name(t.executor)}</span>
            </header>
            {r?.branch && (
              <p className="mono small">
                ⎇ {r.branch}
                <br />
                <span className="muted">{r.worktree}</span>
              </p>
            )}
            {r?.diffStat && <pre className="mono">{r.diffStat}</pre>}
            {out && (
              <details>
                <summary>Executor output</summary>
                <pre className="mono">{out.slice(-6000)}</pre>
              </details>
            )}
            {r?.tests && (
              <details open={r.tests.exitCode !== 0}>
                <summary>
                  Tests: <code>{r.tests.command}</code> → exit {String(r.tests.exitCode)}
                </summary>
                <pre className="mono">{r.tests.output.slice(-6000)}</pre>
              </details>
            )}
            {r?.review && (
              <div className={`review ${r.review.verdict}`}>
                <b>
                  Review by {name(r.review.reviewer)}: {r.review.verdict}
                </b>
                <ul>
                  {r.review.findings.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
