import { useCallback, useEffect, useRef, useState } from "react";
import type { CouncilEvent, Session } from "../../src/shared/types.ts";
import { api, openStream } from "./api.ts";

/** Live view of one session: snapshot + event stream + who is currently "thinking". */
export function useSession(id: string | null) {
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<CouncilEvent[]>([]);
  const [thinking, setThinking] = useState<Record<string, string>>({});
  const [live, setLive] = useState(false);
  const refetchTimer = useRef<number | null>(null);

  const refetch = useCallback(() => {
    if (!id) return;
    if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => {
      api.session(id).then(setSession).catch(() => {});
    }, 120);
  }, [id]);

  useEffect(() => {
    setSession(null);
    setEvents([]);
    setThinking({});
    if (!id) return;
    api.session(id).then(setSession).catch(() => {});
    const seen = new Set<number>();
    const close = openStream(
      id,
      (e) => {
        if (e.type === "member.thinking") {
          setThinking((t) => ({ ...t, [e.actor]: e.phase ?? "" }));
          return;
        }
        if (seen.has(e.seq)) return;
        seen.add(e.seq);
        setThinking((t) => {
          if (!(e.actor in t)) return t;
          const { [e.actor]: _, ...rest } = t;
          return rest;
        });
        setEvents((prev) => [...prev, e]);
        if (e.type !== "task.output") refetch();
      },
      setLive,
    );
    return () => {
      close();
      if (refetchTimer.current) window.clearTimeout(refetchTimer.current);
    };
  }, [id, refetch]);

  // Clear stale "thinking" markers once the session stops deliberating.
  useEffect(() => {
    if (session && !["deliberating", "executing"].includes(session.status)) setThinking({});
  }, [session?.status]);

  return { session, events, thinking, live, refetch };
}

export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fn()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    load();
    if (!intervalMs) return;
    const t = window.setInterval(load, intervalMs);
    return () => window.clearInterval(t);
  }, [load, intervalMs]);
  return { data, error, reload: load };
}
