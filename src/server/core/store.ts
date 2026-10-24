import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session, SessionSummary } from "../../shared/types.ts";
import { now } from "../util/ids.ts";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** One JSON file per session, written atomically (tmp + rename). */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as Session;
        // Work in flight cannot survive a restart; an approval gate can.
        if (s.status === "deliberating" || s.status === "paused" || s.status === "executing") {
          s.status = "failed";
          s.error = "Interrupted by a server restart.";
          s.updatedAt = now();
        }
        this.sessions.set(s.id, s);
      } catch {
        // skip corrupt files rather than refusing to start
      }
    }
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map(({ id, title, status, phase, round, createdAt, updatedAt }) => ({ id, title, status, phase, round, createdAt, updatedAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  save(s: Session): void {
    s.updatedAt = now();
    this.sessions.set(s.id, s);
    const file = join(this.dir, `${s.id}.json`);
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
    renameSync(tmp, file);
  }

  /** Forget a session and delete its file. Only ids the store already knows are touched, so a request can never name another path. */
  remove(id: string): boolean {
    if (!this.sessions.has(id) || !SAFE_ID.test(id)) return false;
    this.sessions.delete(id);
    rmSync(join(this.dir, `${id}.json`), { force: true });
    rmSync(join(this.dir, `${id}.json.tmp`), { force: true });
    return true;
  }

  has(id: string): boolean {
    return this.sessions.has(id) || existsSync(join(this.dir, `${id}.json`));
  }
}
