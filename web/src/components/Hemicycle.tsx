import type { CouncilEvent, MemberInfo, Session } from "../../../src/shared/types.ts";

interface Props {
  members: MemberInfo[];
  session: Session | null;
  thinking: Record<string, string>;
  lastEvent: CouncilEvent | null;
}

const W = 520;
const H = 270;
const CX = W / 2;
const CY = 238;
const R = 190;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : `${s}…`);

/** Members seated on an arc around the current phase; highlights who is thinking, speaking or leading. */
export function Hemicycle({ members, session, thinking, lastEvent }: Props) {
  const seatIds = session ? session.members : members.map((m) => m.id);
  const seated = seatIds.map((id) => members.find((m) => m.id === id)).filter((m): m is MemberInfo => Boolean(m));
  const n = seated.length;
  const pos = new Map<string, { x: number; y: number }>();
  seated.forEach((m, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const a = Math.PI - (0.12 + t * 0.76) * Math.PI;
    pos.set(m.id, { x: CX + R * Math.cos(a), y: CY - R * Math.sin(a) });
  });

  const absentNow = new Set(
    (session?.absent ?? []).filter((a) => a.endsWith(`#${session?.round}`)).map((a) => a.split("@")[0]!),
  );
  const winner = session?.consensus.at(-1)?.winner ?? null;
  const critique = lastEvent?.type === "critique.submitted" ? (lastEvent.data as { author: string; target: string }) : null;
  const speaking = lastEvent && pos.has(lastEvent.actor) ? lastEvent.actor : null;

  return (
    <svg className="hemicycle" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Council chamber">
      {[R + 30, R - 70].map((r) => (
        <path key={r} d={`M ${CX - r} ${CY} A ${r} ${r} 0 0 1 ${CX + r} ${CY}`} className="arc" />
      ))}

      {critique && pos.get(critique.author) && pos.get(critique.target) && (
        <line
          className="beam"
          x1={pos.get(critique.author)!.x}
          y1={pos.get(critique.author)!.y}
          x2={pos.get(critique.target)!.x}
          y2={pos.get(critique.target)!.y}
        />
      )}
      {seated.map((m) => {
        const p = pos.get(m.id)!;
        return <line key={`ray-${m.id}`} className="ray" x1={p.x} y1={p.y} x2={CX} y2={CY - 30} />;
      })}

      <g className="podium">
        <rect x={CX - 84} y={CY - 52} width={168} height={44} rx={8} />
        <text x={CX} y={CY - 34} className="podium-phase">
          {session ? session.phase[0]!.toUpperCase() + session.phase.slice(1) : "Idle"}
        </text>
        <text x={CX} y={CY - 18} className="podium-round">
          {session ? `round ${session.round} · ${session.status.replace("_", " ")}` : "no debate selected"}
        </text>
      </g>

      {seated.map((m) => {
        const p = pos.get(m.id)!;
        const isThinking = m.id in thinking;
        const cls = ["seat", isThinking && "thinking", speaking === m.id && "speaking", absentNow.has(m.id) && "absent", winner === m.id && "winner"]
          .filter(Boolean)
          .join(" ");
        return (
          <g key={m.id} className={cls} transform={`translate(${p.x} ${p.y})`} style={{ ["--c" as string]: m.color }}>
            <title>{`${m.name} · ${m.roles.join(", ")} · ${m.adapter}${m.model ? ` (${m.model})` : ""}${isThinking ? `\n${thinking[m.id]}` : ""}`}</title>
            <circle r={30} className="halo" />
            <circle r={22} className="disc" />
            <text className="initials" dy="5">
              {initials(m.name)}
            </text>
            <text className="name" y={42}>
              {m.name}
            </text>
            <text className="role" y={55}>
              {isThinking ? clip(thinking[m.id] ?? "", 28) : m.roles.slice(0, 2).join(" · ")}
            </text>
            {winner === m.id && (
              <circle className="crown" cy={-30} r={4} />
            )}
          </g>
        );
      })}
    </svg>
  );
}
