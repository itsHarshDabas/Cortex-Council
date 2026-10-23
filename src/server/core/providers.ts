import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROVIDER_KINDS,
  type KeySource,
  type ProviderInput,
  type ProviderKind,
  type ProviderView,
  type SeatInput,
  type SeatView,
} from "../../shared/providers.ts";
import type { Role } from "../../shared/types.ts";
import { ValidationError } from "../orchestrator/sessionManager.ts";
import { now } from "../util/ids.ts";
import { registerSecret } from "../util/redact.ts";

export interface ProviderRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  keySource: KeySource;
  apiKeyEnv?: string;
  createdAt: string;
  updatedAt: string;
}

/** What an adapter needs to reach a provider. The key is only ever held in memory. */
export interface ResolvedProvider {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

const ROLES: readonly Role[] = ["strategist", "skeptic", "engineer", "security", "reviewer", "researcher", "speaker", "executor"];
const DEFAULT_URL: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "provider";

function text(v: unknown, field: string, max: number, required = true): string | undefined {
  const s = typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
  if (!s) {
    if (required) throw new ValidationError(`${field} is required.`);
    return undefined;
  }
  if (s.length > max) throw new ValidationError(`${field} is too long (max ${max}).`);
  return s;
}

export function normalizeBaseUrl(raw: unknown, kind: ProviderKind): string {
  const value = text(raw, "baseUrl", 500, false) ?? DEFAULT_URL[kind];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("baseUrl must be a full URL, e.g. https://api.example.com/v1.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ValidationError("baseUrl must use http or https.");
  if (url.username || url.password) throw new ValidationError("Put credentials in the key field, not in baseUrl.");
  if (url.search || url.hash) throw new ValidationError("baseUrl must not have a query string or fragment.");
  return url.toString().replace(/\/+$/, "");
}

function validKey(raw: unknown): string {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key.length < 8 || key.length > 4096) throw new ValidationError("The API key looks wrong (expected 8 to 4096 characters).");
  if (/\s/.test(key)) throw new ValidationError("The API key must not contain spaces or line breaks.");
  return key;
}

/** Atomic write; `secret` files are owner-only (0600; best effort on Windows). */
function writeFile(file: string, data: unknown, secret = false) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    throw new ValidationError(`${file} is not valid JSON; fix or delete it.`);
  }
}

/**
 * UI-managed API providers and the members seated on them.
 * - <dataDir>/providers.json: providers and seats, no secrets.
 * - <dataDir>/secrets.json: pasted keys, keyed by provider id, mode 0600. Never returned by the API.
 * Prefer env-var references: then no key touches disk at all.
 */
export class ProviderStore {
  private providers: ProviderRecord[] = [];
  private seats: SeatView[] = [];
  private secrets: Record<string, string> = {};
  private readonly file: string;
  private readonly secretsFile: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    // Keep the data dir out of git even when it lives somewhere other than ./.cortex.
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n", "utf8");
    this.file = join(dir, "providers.json");
    this.secretsFile = join(dir, "secrets.json");
    const data = readJson<{ providers?: ProviderRecord[]; seats?: SeatView[] }>(this.file, {});
    this.providers = data.providers ?? [];
    this.seats = data.seats ?? [];
    this.secrets = readJson<Record<string, string>>(this.secretsFile, {});
    if (existsSync(this.secretsFile)) chmodSync(this.secretsFile, 0o600);
    for (const key of Object.values(this.secrets)) registerSecret(key);
  }

  private save() {
    writeFile(this.file, { providers: this.providers, seats: this.seats });
  }

  private saveSecrets() {
    writeFile(this.secretsFile, this.secrets, true);
  }

  get(id: string): ProviderRecord | undefined {
    return this.providers.find((p) => p.id === id);
  }

  hasStoredKey(id: string): boolean {
    return Boolean(this.secrets[id]);
  }

  list(): ProviderView[] {
    return this.providers.map((p) => this.view(p));
  }

  view(p: ProviderRecord): ProviderView {
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      keySource: p.keySource,
      ...(p.keySource === "env" ? { apiKeyEnv: p.apiKeyEnv, envPresent: Boolean(p.apiKeyEnv && process.env[p.apiKeyEnv]) } : {}),
      members: this.seats.filter((s) => s.provider === p.id).map((s) => s.id),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  /** URL + key for an adapter, or undefined if the provider is gone. */
  resolve(id: string): ResolvedProvider | undefined {
    const p = this.get(id);
    if (!p) return undefined;
    return {
      kind: p.kind,
      baseUrl: p.baseUrl,
      ...(p.keySource === "stored" ? { apiKey: this.secrets[p.id] } : {}),
      ...(p.keySource === "env" ? { apiKeyEnv: p.apiKeyEnv } : {}),
    };
  }

  /** Validate a create/update body. `existing` lets an update keep its stored key. */
  parse(input: Partial<ProviderInput>, existing?: ProviderRecord): { record: Omit<ProviderRecord, "id" | "createdAt" | "updatedAt">; key?: string } {
    const name = text(input.name ?? existing?.name, "name", 80)!;
    const kind = (input.kind ?? existing?.kind) as ProviderKind;
    if (!PROVIDER_KINDS.includes(kind)) throw new ValidationError(`kind must be one of ${PROVIDER_KINDS.join(", ")}.`);
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? existing?.baseUrl, kind);
    const keySource = (input.keySource ?? existing?.keySource ?? "none") as KeySource;
    if (!["none", "env", "stored"].includes(keySource)) throw new ValidationError("keySource must be none, env or stored.");
    let apiKeyEnv: string | undefined;
    let key: string | undefined;
    if (keySource === "env") {
      apiKeyEnv = text(input.apiKeyEnv ?? existing?.apiKeyEnv, "apiKeyEnv", 128);
      if (!ENV_RE.test(apiKeyEnv!)) throw new ValidationError("apiKeyEnv must be an environment variable name, e.g. GROQ_API_KEY.");
    }
    if (keySource === "stored") {
      if (input.apiKey !== undefined && input.apiKey !== "") key = validKey(input.apiKey);
      else if (!existing || !this.hasStoredKey(existing.id)) throw new ValidationError("Paste an API key, or reference an environment variable instead.");
    }
    if (keySource === "none" && kind !== "openai") throw new ValidationError(`${kind} needs an API key.`);
    return { record: { name, kind, baseUrl, keySource, ...(apiKeyEnv ? { apiKeyEnv } : {}) }, key };
  }

  create(input: Partial<ProviderInput>): ProviderRecord {
    const { record, key } = this.parse(input);
    let id = slug(record.name);
    for (let n = 2; this.get(id); n++) id = `${slug(record.name).slice(0, 36)}-${n}`;
    const t = now();
    const p: ProviderRecord = { id, ...record, createdAt: t, updatedAt: t };
    this.providers.push(p);
    this.setKey(id, record.keySource === "stored" ? key : undefined, record.keySource === "stored");
    this.save();
    return p;
  }

  update(id: string, input: Partial<ProviderInput>): ProviderRecord {
    const existing = this.get(id);
    if (!existing) throw new ValidationError(`Unknown provider "${id}".`);
    const { record, key } = this.parse(input, existing);
    Object.assign(existing, record, { updatedAt: now() });
    if (record.keySource !== "env") delete existing.apiKeyEnv;
    this.setKey(id, key, record.keySource === "stored");
    this.save();
    return existing;
  }

  /** Store `key` if given; drop the stored key when the provider no longer uses one. */
  private setKey(id: string, key: string | undefined, keep: boolean) {
    if (key) {
      registerSecret(key);
      this.secrets[id] = key;
      this.saveSecrets();
    } else if (!keep && this.secrets[id]) {
      delete this.secrets[id];
      this.saveSecrets();
    }
  }

  remove(id: string): boolean {
    const before = this.providers.length;
    this.providers = this.providers.filter((p) => p.id !== id);
    if (this.providers.length === before) return false;
    this.setKey(id, undefined, false);
    this.save();
    return true;
  }

  // ---- seats ---------------------------------------------------------------

  listSeats(): SeatView[] {
    return this.seats.map((s) => ({ ...s, committees: [...s.committees] }));
  }

  getSeat(id: string): SeatView | undefined {
    return this.seats.find((s) => s.id === id);
  }

  /** Validate a seat. `taken` are ids already used by other members. */
  parseSeat(input: Partial<SeatInput>, taken: Set<string>, existing?: SeatView): SeatView {
    const name = text(input.name ?? existing?.name, "name", 60)!;
    const provider = text(input.provider ?? existing?.provider, "provider", 60)!;
    if (!this.get(provider)) throw new ValidationError(`Unknown provider "${provider}".`);
    const model = text(input.model ?? existing?.model, "model", 200)!;
    const roles = (input.roles ?? existing?.roles ?? []) as Role[];
    if (!Array.isArray(roles) || roles.some((r) => !ROLES.includes(r))) throw new ValidationError(`roles must be from: ${ROLES.join(", ")}.`);
    if (roles.includes("executor")) throw new ValidationError("API models cannot execute tasks; seat a CLI agent as the executor.");
    let id = existing?.id;
    if (!id) {
      id = input.id ? text(input.id, "id", 48)!.toLowerCase() : slug(name);
      if (!ID_RE.test(id)) throw new ValidationError("id may contain only a-z, 0-9, - and _.");
      if (input.id && taken.has(id)) throw new ValidationError(`A member with id "${id}" already exists.`);
      const base = id.slice(0, 44);
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    }
    const color = text(input.color ?? existing?.color, "color", 20, false);
    if (color && !/^#[0-9a-f]{3,8}$/i.test(color)) throw new ValidationError("color must be a hex colour like #38bdf8.");
    const num = (v: unknown, field: string, min: number, max: number) => {
      if (v === undefined || v === null || v === "") return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}.`);
      return n;
    };
    const committees = input.committees ?? existing?.committees ?? [];
    if (!Array.isArray(committees)) throw new ValidationError("committees must be a list.");
    return {
      id,
      name,
      provider,
      model,
      roles: [...new Set(roles)],
      persona: text(input.persona ?? existing?.persona, "persona", 1000, false),
      color,
      committees: [...new Set(committees.map(String))],
      temperature: num(input.temperature ?? existing?.temperature, "temperature", 0, 2),
      maxTokens: num(input.maxTokens ?? existing?.maxTokens, "maxTokens", 1, 1_000_000),
    };
  }

  putSeat(seat: SeatView) {
    const i = this.seats.findIndex((s) => s.id === seat.id);
    if (i >= 0) this.seats[i] = seat;
    else this.seats.push(seat);
    this.save();
  }

  removeSeat(id: string): boolean {
    const before = this.seats.length;
    this.seats = this.seats.filter((s) => s.id !== id);
    if (this.seats.length !== before) this.save();
    return this.seats.length !== before;
  }
}
