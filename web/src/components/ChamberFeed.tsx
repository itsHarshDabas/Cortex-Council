import { useEffect, useRef, useState } from "react";
import type { CouncilEvent, MemberInfo, Proposal } from "../../../src/shared/types.ts";

const KIND: Partial<Record<CouncilEvent["type"], string>> = {
  "proposal.submitted": "proposal",
  "critique.submitted": "critique",
  "ballot.cast": "vote",
  "consensus.computed": "consensus",
  "plan.synthesized": "plan",
  "architect.interjected": "architect",
  "architect.approved": "architect",
  "architect.rejected": "architect",
  "architect.amended": "architect",
  "member.absent": "warn",
  error: "error",
  "session.report": "report",
  "task.started": "task",
  "task.finished": "task",
  "phase.started": "phase",
};

const HIDDEN = new Set<CouncilEvent["type"]>(["task.output", "session.status"]);

export function ChamberFeed({ events, members }: { events: CouncilEvent[]; members: MemberInfo[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const visible = events.filter((e) => !HIDDEN.has(e.type));

  useEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [visible.length, stick]);

  const who = (id: string) => members.find((m) => m.id === id);

  return (
    <div
      className="feed"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
      }}
      aria-live="polite"
    >
      {visible.length === 0 && <div className="empty">The chamber is quiet. Table a motion to begin.</div>}
      {visible.map((e) => {
        const kind = KIND[e.type] ?? "system";
        if (e.type === "phase.started") {
          return (
            <div key={e.seq} className="divider">
              <span>{e.phase}</span>
              <em>{e.text}</em>
            </div>
          );
        }
        const m = who(e.actor);
        const name = m?.name ?? (e.actor === "architect" ? "Architect" : "Council");
        const color = m?.color ?? (e.actor === "architect" ? "#fbbf24" : "#94a3b8");
        const proposal = e.type === "proposal.submitted" ? (e.data as Proposal) : null;
        return (
          <article key={e.seq} className={`msg ${kind}`} style={{ ["--c" as string]: color }}>
            <header>
              <span className="who">{name}</span>
              <span className="tag">{e.type.split(".")[0] === "architect" ? e.type.split(".")[1] : (e.phase ?? kind)}</span>
              <time>{new Date(e.at).toLocaleTimeString()}</time>
            </header>
            <p>{e.text}</p>
            {proposal && proposal.steps.length > 0 && (
              <details>
                <summary>{proposal.steps.length} steps · confidence {Math.round(proposal.confidence * 100)}%</summary>
                <ol>
                  {proposal.steps.map((s, i) => (
                    <li key={i}>
                      <b>{s.title}</b> {s.detail}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </article>
        );
      })}
    </div>
  );
}
