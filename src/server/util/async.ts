export class AbortedError extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortedError";
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 90000 → "90s", 600000 → "10 min". */
export const formatDuration = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms >= 120_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)}s`;

/** Run fn with a per-attempt timeout and exponential backoff between attempts. */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  /** retryOnTimeout: false gives up after a timed-out attempt (a slow agent would just time out again). */
  opts: { retries: number; timeoutMs: number; baseDelayMs?: number; signal?: AbortSignal; retryOnTimeout?: boolean },
): Promise<T> {
  const base = opts.baseDelayMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (opts.signal?.aborted) throw new AbortedError();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${formatDuration(opts.timeoutMs)}`)), opts.timeoutMs);
    try {
      return await fn(ctrl.signal);
    } catch (err) {
      if (opts.signal?.aborted) throw new AbortedError();
      const timedOut = ctrl.signal.reason instanceof Error;
      lastErr = timedOut ? ctrl.signal.reason : err;
      if (timedOut && opts.retryOnTimeout === false) break;
      if (attempt < opts.retries) await sleep(base * 2 ** attempt, opts.signal);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Map over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
