import type { Phase, Session } from "../../../src/shared/types.ts";

const PHASES: { id: Phase; label: string }[] = [
  { id: "proposal", label: "Propose" },
  { id: "critique", label: "Critique" },
  { id: "revision", label: "Revise" },
  { id: "vote", label: "Vote" },
  { id: "synthesis", label: "Synthesize" },
  { id: "approval", label: "Approve" },
  { id: "execution", label: "Execute" },
  { id: "verification", label: "Verify" },
  { id: "report", label: "Report" },
];

export function PhaseTimeline({ session }: { session: Session | null }) {
  const current = PHASES.findIndex((p) => p.id === session?.phase);
  const finished = session?.status === "completed";
  return (
    <ol className="timeline">
      {PHASES.map((p, i) => {
        const state = finished || i < current ? "done" : i === current ? "active" : "todo";
        return (
          <li key={p.id} className={state}>
            <span className="dot" />
            <span className="label">{p.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
