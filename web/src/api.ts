import type {
  CommitteeInfo,
  CouncilEvent,
  CreateSessionRequest,
  MemberInfo,
  Session,
  SessionSummary,
} from "../../src/shared/types.ts";

export interface CouncilInfo {
  members: MemberInfo[];
  committees: CommitteeInfo[];
  defaults: { speaker: string; reviewer: string; maxRounds: number; consensusThreshold: number };
  execution: { workspace: string; testCommand: string[] };
}

export interface AuditEntry extends CouncilEvent {
  prev: string;
  hash: string;
}

export interface MemoryEntry {
  id: string;
  at: string;
  sessionId?: string;
  title: string;
  content: string;
  tags: string[];
}

const TOKEN_KEY = "cortex.token";
export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
export const setToken = (t: string) => {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* storage unavailable */
  }
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

export const api = {
  council: () => call<CouncilInfo>("GET", "/council"),
  health: () => call<Record<string, { ok: boolean; detail?: string }>>("GET", "/adapters/health"),
  sessions: () => call<SessionSummary[]>("GET", "/sessions"),
  session: (id: string) => call<Session>("GET", `/sessions/${id}`),
  create: (req: CreateSessionRequest) => call<Session>("POST", "/sessions", req),
  interject: (id: string, text: string) => call("POST", `/sessions/${id}/interject`, { text }),
  control: (id: string, action: "pause" | "resume" | "abort") => call("POST", `/sessions/${id}/${action}`, {}),
  approve: (id: string, note?: string) => call("POST", `/sessions/${id}/approve`, { note }),
  reject: (id: string, reason?: string) => call("POST", `/sessions/${id}/reject`, { reason }),
  amend: (id: string, text: string) => call("POST", `/sessions/${id}/amend`, { text }),
  audit: (session?: string) => call<AuditEntry[]>("GET", `/audit?limit=500${session ? `&session=${session}` : ""}`),
  verifyAudit: () => call<{ ok: boolean; entries: number; brokenAt?: number; reason?: string }>("GET", "/audit/verify"),
  memory: () => call<MemoryEntry[]>("GET", "/memory"),
  addMemory: (title: string, content: string) => call<MemoryEntry>("POST", "/memory", { title, content }),
  deleteMemory: (id: string) => call("DELETE", `/memory/${id}`),
};

export function openStream(sessionId: string, onEvent: (e: CouncilEvent) => void, onState: (live: boolean) => void): () => void {
  const token = getToken();
  const qs = new URLSearchParams({ session: sessionId });
  if (token) qs.set("token", token);
  const es = new EventSource(`/api/stream?${qs}`);
  es.addEventListener("council", (m) => onEvent(JSON.parse((m as MessageEvent).data)));
  es.addEventListener("ready", () => onState(true));
  es.onerror = () => onState(false);
  return () => es.close();
}
