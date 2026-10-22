const secrets = new Set<string>();

/** Register a secret value (e.g. an API key) so it is scrubbed from logs and events. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

const patterns: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
];

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  for (const p of patterns) out = out.replace(p, "[REDACTED]");
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
