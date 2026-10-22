import type { CouncilEvent } from "../../shared/types.ts";
import { now } from "../util/ids.ts";
import { redactDeep } from "../util/redact.ts";
import type { AuditLog } from "./audit.ts";

type Listener = (e: CouncilEvent) => void;

/** Events that only matter live (typing indicators) and are not written to the audit log. */
const EPHEMERAL = new Set<CouncilEvent["type"]>(["member.thinking"]);
const HISTORY_LIMIT = 5000;

export class EventBus {
  private seq = 0;
  private readonly listeners = new Set<Listener>();
  private readonly history = new Map<string, CouncilEvent[]>();

  constructor(private readonly audit: AuditLog) {
    // Rebuild per-session history from the audit log so the UI can replay after a restart.
    for (const entry of audit.readAll()) {
      const { prev: _p, hash: _h, ...event } = entry;
      this.remember(event);
      this.seq = Math.max(this.seq, event.seq);
    }
  }

  emit(e: Omit<CouncilEvent, "seq" | "at">): CouncilEvent {
    const event = redactDeep({ ...e, seq: ++this.seq, at: now() }) as CouncilEvent;
    if (!EPHEMERAL.has(event.type)) {
      this.audit.append(event);
      this.remember(event);
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a broken subscriber must never break the council
      }
    }
    return event;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  historyFor(sessionId: string): CouncilEvent[] {
    return this.history.get(sessionId) ?? [];
  }

  private remember(e: CouncilEvent) {
    const list = this.history.get(e.sessionId) ?? [];
    list.push(e);
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
    this.history.set(e.sessionId, list);
  }
}
