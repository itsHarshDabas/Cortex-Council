import { useState } from "react";
import { api } from "../api.ts";
import { usePoll } from "../hooks.ts";

export function AuditPanel({ sessionId, version }: { sessionId: string; version: number }) {
  const { data, error } = usePoll(() => api.audit(sessionId), [sessionId, version]);
  const [verify, setVerify] = useState<string | null>(null);
  return (
    <div className="panel-body">
      <div className="row between">
        <span className="muted small">Hash-chained, append-only log. Every event below is tamper-evident.</span>
        <button
          onClick={() =>
            api
              .verifyAudit()
              .then((v) => setVerify(v.ok ? `✓ Chain intact (${v.entries} entries)` : `✕ Broken at entry ${v.brokenAt}: ${v.reason}`))
              .catch((e: Error) => setVerify(e.message))
          }
        >
          Verify chain
        </button>
      </div>
      {verify && <div className={`verify ${verify.startsWith("✓") ? "ok" : "bad"}`}>{verify}</div>}
      {error && <div className="error">{error}</div>}
      <table className="audit">
        <thead>
          <tr>
            <th>#</th>
            <th>Time</th>
            <th>Event</th>
            <th>Actor</th>
            <th>Hash</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? [])
            .slice()
            .reverse()
            .map((e) => (
              <tr key={e.hash} title={e.text}>
                <td>{e.seq}</td>
                <td>{new Date(e.at).toLocaleTimeString()}</td>
                <td>{e.type}</td>
                <td>{e.actor}</td>
                <td className="mono">{e.hash.slice(0, 10)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
