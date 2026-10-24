import { useState } from "react";
import type { Session } from "../../../src/shared/types.ts";
import { api } from "../api.ts";
import { confirmDialog, Icon } from "./ui.tsx";

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
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={active ? "Add a constraint, challenge a member or redirect the debate…" : "This debate has ended"}
        disabled={!active}
        aria-label="Interjection"
      />
      <button type="submit" className="primary" disabled={!active || !text.trim()}>
        Send
      </button>
      {session.status === "paused" ? (
        <button type="button" onClick={() => run(api.control(session.id, "resume"))}>
          <Icon name="play" size={14} /> Resume
        </button>
      ) : (
        <button type="button" disabled={!["deliberating", "executing"].includes(session.status)} onClick={() => run(api.control(session.id, "pause"))}>
          <Icon name="pause" size={14} /> Pause
        </button>
      )}
      <button
        type="button"
        className="danger"
        disabled={!active}
        onClick={async () => {
          const ok = await confirmDialog({
            title: "Abort this debate?",
            body: "In-flight work stops and nothing further executes.",
            confirmLabel: "Abort debate",
            danger: true,
          });
          if (ok) run(api.control(session.id, "abort"));
        }}
      >
        <Icon name="stop" size={14} /> Abort
      </button>
    </form>
  );
}
