import type { SessionSummary } from "../../../src/shared/types.ts";
import { Icon, statusLabel } from "./ui.tsx";

const LIVE = new Set(["deliberating", "paused", "executing"]);

export function SessionList({
  sessions,
  selected,
  onSelect,
  onDelete,
}: {
  sessions: SessionSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
  onDelete: (s: SessionSummary) => void;
}) {
  if (sessions.length === 0) return <p className="muted small empty-note">No debates yet.</p>;
  return (
    <ul className="sessions">
      {sessions.map((s) => (
        <li key={s.id} className={s.id === selected ? "selected" : ""}>
          <button type="button" className="session-item" onClick={() => onSelect(s.id)} aria-current={s.id === selected ? "true" : undefined}>
            <span className={`status-dot ${s.status}`} aria-hidden="true" />
            <span className="title">{s.title}</span>
            <span className="meta">
              {statusLabel(s.status)} · {new Date(s.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          </button>
          <button
            type="button"
            className="ghost icon-only sm session-delete"
            onClick={() => onDelete(s)}
            disabled={LIVE.has(s.status)}
            aria-label={`Delete debate "${s.title}"`}
            title={LIVE.has(s.status) ? "Abort the debate before deleting it" : "Delete debate"}
          >
            <Icon name="trash" size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}
