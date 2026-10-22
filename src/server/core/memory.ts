import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newId, now } from "../util/ids.ts";

export interface MemoryEntry {
  id: string;
  at: string;
  sessionId?: string;
  title: string;
  content: string;
  tags: string[];
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

/** Shared project memory: decisions the Architect approved, recalled into later debates. */
export class ProjectMemory {
  private entries: MemoryEntry[] = [];

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        this.entries = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        this.entries = [];
      }
    }
  }

  all(): MemoryEntry[] {
    return [...this.entries].reverse();
  }

  add(e: Omit<MemoryEntry, "id" | "at">): MemoryEntry {
    const entry = { ...e, id: newId("mem"), at: now() };
    this.entries.push(entry);
    writeFileSync(this.file, JSON.stringify(this.entries, null, 2), "utf8");
    return entry;
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) writeFileSync(this.file, JSON.stringify(this.entries, null, 2), "utf8");
    return this.entries.length !== before;
  }

  /** Top-k entries by keyword overlap with the query, most recent first on ties. */
  recall(query: string, k = 5): MemoryEntry[] {
    const q = words(query);
    return this.entries
      .map((e, i) => {
        const w = words(`${e.title} ${e.content} ${e.tags.join(" ")}`);
        let overlap = 0;
        for (const t of q) if (w.has(t)) overlap++;
        return { e, score: overlap + i / 1e6 };
      })
      .filter((x) => x.score >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.e);
  }
}
