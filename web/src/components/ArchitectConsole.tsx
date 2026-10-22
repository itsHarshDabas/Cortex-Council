import { useState } from "react";
import type { Session } from "../../../src/shared/types.ts";
import { api } from "../api.ts";

export function ArchitectConsole({ session, onError }: { session: Session; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const active = ["deliberating", "paused", "awaiting_approval", "executing"].includes(session.status);
  const run = (p: Promise<unknown>) => p.catch((e: Error) => onError(e.message));

  return (
    <form
      className="console"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        run(api.interject(session.id, text).then(() => setText("")));
      }}
    >
      <span className="prompt">ARCHITECT ›</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={active ? "Interject: add a constraint, challenge a member, redirect the debate…" : "Session closed"}
        disabled={!active}
        aria-label="Interjection"
      />
      <button type="submit" disabled={!active || !text.trim()}>
        Interject
      </button>
      {session.status === "paused" ? (
        <button type="button" onClick={() => run(api.control(session.id, "resume"))}>
          Resume
        </button>
      ) : (
        <button type="button" disabled={!["deliberating", "executing"].includes(session.status)} onClick={() => run(api.control(session.id, "pause"))}>
          Pause
        </button>
      )}
      <button
        type="button"
        className="danger"
        disabled={!active}
        onClick={() => confirm("Abort this session? In-flight work stops and nothing further executes.") && run(api.control(session.id, "abort"))}
      >
        Abort
      </button>
    </form>
  );
}
