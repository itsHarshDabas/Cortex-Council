import { useState } from "react";
import { api } from "../api.ts";
import { usePoll } from "../hooks.ts";

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
        <button type="submit">Remember</button>
      </form>
      {error && <div className="error">{error}</div>}
      <ul className="memory">
        {(data ?? []).map((m) => (
          <li key={m.id}>
            <div className="row between">
              <b>{m.title}</b>
              <button className="link" onClick={() => api.deleteMemory(m.id).then(reload)} aria-label="Forget">
                forget
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
