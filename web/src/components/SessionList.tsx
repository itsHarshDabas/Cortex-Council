import type { SessionSummary } from "../../../src/shared/types.ts";

export function SessionList({ sessions, selected, onSelect }: { sessions: SessionSummary[]; selected: string | null; onSelect: (id: string) => void }) {
  if (sessions.length === 0) return <p className="muted small">No motions yet.</p>;
  return (
    <ul className="sessions">
      {sessions.map((s) => (
        <li key={s.id}>
          <button className={s.id === selected ? "selected" : ""} onClick={() => onSelect(s.id)}>
            <span className={`status-dot ${s.status}`} />
            <span className="title">{s.title}</span>
            <span className="meta">
              {s.status.replace("_", " ")} · {new Date(s.createdAt).toLocaleDateString()}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
