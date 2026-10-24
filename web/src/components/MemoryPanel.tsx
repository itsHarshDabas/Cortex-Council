import { useState } from "react";
import { api } from "../api.ts";
import { usePoll } from "../hooks.ts";
import { confirmDialog, Icon } from "./ui.tsx";

export function MemoryPanel({ version }: { version: number }) {
  const { data, error, reload } = usePoll(() => api.memory(), [version]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  return (
    <div className="panel-body">
      <p className="muted small">Shared project memory. Approved plans are saved here automatically and recalled into future debates.</p>
      <form
        className="memory-form"
        onSubmit={(e) => {
          e.preventDefault();
          api.addMemory(title, content).then(() => {
            setTitle("");
            setContent("");
            reload();
          });
        }}
      >
        <input placeholder="Decision or fact" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <textarea placeholder="Details the council should remember" value={content} onChange={(e) => setContent(e.target.value)} rows={2} required />
        <button type="submit" className="self-start">
          Remember
        </button>
      </form>
      {error && <div className="error">{error}</div>}
      <ul className="memory">
        {(data ?? []).map((m) => (
          <li key={m.id}>
            <div className="row between">
              <b>{m.title}</b>
              <button
                type="button"
                className="ghost icon-only sm"
                onClick={async () => {
                  if (await confirmDialog({ title: "Forget this memory?", body: m.title, confirmLabel: "Forget", danger: true })) api.deleteMemory(m.id).then(reload);
                }}
                aria-label={`Forget "${m.title}"`}
                title="Forget"
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
            <p>{m.content}</p>
            <span className="muted small">{new Date(m.at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
