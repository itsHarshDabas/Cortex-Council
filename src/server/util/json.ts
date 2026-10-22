/**
 * Lenient JSON extraction for model output. Models wrap JSON in prose or
 * code fences, so we try: the whole text, fenced blocks, then the first
 * balanced {...} object. Returns null when nothing parses.
 */
export function extractJson<T = unknown>(text: string): T | null {
  const candidates: string[] = [text.trim()];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (m[1]) candidates.push(m[1].trim());
  }
  const balanced = firstBalancedObject(text);
  if (balanced) candidates.push(balanced);

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") return parsed as T;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : v == null ? fallback : String(v);

export const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).filter(Boolean) : [];

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
