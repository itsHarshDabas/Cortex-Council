import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CouncilEvent } from "../../shared/types.ts";

export interface AuditEntry extends CouncilEvent {
  prev: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

const digest = (prev: string, event: CouncilEvent) =>
  createHash("sha256").update(prev).update(JSON.stringify(event)).digest("hex");

/**
 * Append-only, hash-chained JSONL log. Each line stores the hash of the
 * previous line, so editing, deleting or reordering any entry breaks the chain
 * from that point on and `verify()` reports where.
 */
export class AuditLog {
  private lastHash = GENESIS;
  private count = 0;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const entries = this.readAll();
      const last = entries.at(-1);
      if (last) this.lastHash = last.hash;
      this.count = entries.length;
    }
  }

  append(event: CouncilEvent): AuditEntry {
    const hash = digest(this.lastHash, event);
    const entry: AuditEntry = { ...event, prev: this.lastHash, hash };
    appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf8");
    this.lastHash = hash;
    this.count++;
    return entry;
  }

  readAll(): AuditEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry);
  }

  get size() {
    return this.count;
  }

  verify(): { ok: boolean; entries: number; brokenAt?: number; reason?: string } {
    let lines: string[];
    try {
      lines = existsSync(this.file) ? readFileSync(this.file, "utf8").split("\n").filter(Boolean) : [];
    } catch (err) {
      return { ok: false, entries: 0, reason: (err as Error).message };
    }
    let prev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      let entry: AuditEntry;
      try {
        entry = JSON.parse(lines[i]!);
      } catch {
        return { ok: false, entries: lines.length, brokenAt: i, reason: "unparseable line" };
      }
      const { prev: p, hash, ...event } = entry;
      if (p !== prev) return { ok: false, entries: lines.length, brokenAt: i, reason: "prev hash mismatch" };
      if (digest(prev, event as CouncilEvent) !== hash)
        return { ok: false, entries: lines.length, brokenAt: i, reason: "content hash mismatch" };
      prev = hash;
    }
    return { ok: true, entries: lines.length };
  }
}
