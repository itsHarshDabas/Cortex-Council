import { useState } from "react";
import type { Session } from "../../../src/shared/types.ts";
import { api, type CouncilInfo } from "../api.ts";

const PRESETS = [
  {
    title: "Add rate limiting to the API",
    task: "Design and implement rate limiting for our public REST API. It must not break existing clients, must be configurable per route, and must be observable.",
  },
  {
    title: "Choose a local vector store",
    task: "Pick a local-first vector store for project memory (embeddings over docs and past decisions). Compare options, then plan the integration.",
  },
  {
    title: "Harden the CLI executor",
    task: "Review how agent CLIs are executed and propose hardening: sandboxing, resource limits, secret handling, and audit coverage.",
  },
];

export function NewMotion({ council, onCreated, onClose }: { council: CouncilInfo; onCreated: (s: Session) => void; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<string>("full");
  const [custom, setCustom] = useState<string[]>(council.members.map((m) => m.id));
  const [rounds, setRounds] = useState(council.defaults.maxRounds);
  const [threshold, setThreshold] = useState(council.defaults.consensusThreshold);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api.create({
        title,
        task,
        ...(mode === "custom" ? { members: custom } : { committee: mode }),
        maxRounds: rounds,
        consensusThreshold: threshold,
      });
      onCreated(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h2>Table a motion</h2>
        <div className="presets">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.title}
              onClick={() => {
                setTitle(p.title);
                setTask(p.task);
              }}
            >
              {p.title}
            </button>
          ))}
        </div>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
        </label>
        <label>
          Task for the council
          <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={5} required />
        </label>
        <label>
          Convene
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {council.committees.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.members.length})
              </option>
            ))}
            <option value="custom">Hand-pick members…</option>
          </select>
        </label>
        {mode === "custom" && (
          <div className="checks">
            {council.members.map((m) => (
              <label key={m.id} style={{ ["--c" as string]: m.color }}>
                <input
                  type="checkbox"
                  checked={custom.includes(m.id)}
                  onChange={(e) => setCustom((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)))}
                />
                {m.name} <small>{m.roles.join(", ")}</small>
              </label>
            ))}
          </div>
        )}
        <div className="row">
          <label>
            Max rounds
            <input type="number" min={1} max={5} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} />
          </label>
          <label>
            Consensus threshold · {Math.round(threshold * 100)}%
            <input type="range" min={0.5} max={1} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
        </div>
        {error && <div className="error">{error}</div>}
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Convening…" : "Open debate"}
          </button>
        </footer>
      </form>
    </div>
  );
}
