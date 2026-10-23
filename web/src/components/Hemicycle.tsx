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

/** The parliament floor: members seated on an arc, the Speaker's podium in the middle. */
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
      <defs>
        <radialGradient id="floor" cx="50%" cy="100%" r="80%">
          <stop offset="0%" stopColor="rgba(56,189,248,0.22)" />
          <stop offset="60%" stopColor="rgba(129,140,248,0.06)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </radialGradient>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d={`M ${CX - R - 30} ${CY} A ${R + 30} ${R + 30} 0 0 1 ${CX + R + 30} ${CY} Z`} fill="url(#floor)" />
      {[R + 30, R - 40, R - 100].map((r) => (
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
        <rect x={CX - 70} y={CY - 52} width={140} height={44} rx={10} />
        <text x={CX} y={CY - 34} className="podium-phase">
          {(session?.phase ?? "standby").toUpperCase()}
        </text>
        <text x={CX} y={CY - 18} className="podium-round">
          {session ? `round ${session.round} · ${session.status.replace("_", " ")}` : "no motion on the floor"}
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
            <circle r={22} className="disc" filter="url(#glow)" />
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
              <text className="crown" y={-32}>
                ◆
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
