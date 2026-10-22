import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/server/core/audit.ts";
import { EventBus } from "../src/server/core/eventBus.ts";
import { registerSecret } from "../src/server/util/redact.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "cortex-audit-")), "audit.jsonl");
const ev = (seq: number, text: string) => ({ seq, at: "t", sessionId: "s", type: "session.status" as const, actor: "system", text });

describe("AuditLog", () => {
  it("verifies an intact chain and resumes it after reopening", () => {
    const file = fresh();
    const a = new AuditLog(file);
    a.append(ev(1, "one"));
    a.append(ev(2, "two"));
    const b = new AuditLog(file);
    b.append(ev(3, "three"));
    expect(b.verify()).toEqual({ ok: true, entries: 3 });
  });

  it("detects edited content", () => {
    const file = fresh();
    const a = new AuditLog(file);
    a.append(ev(1, "approve plan A"));
    a.append(ev(2, "execute"));
    writeFileSync(file, readFileSync(file, "utf8").replace("plan A", "plan B"));
    expect(a.verify()).toMatchObject({ ok: false, brokenAt: 0, reason: "content hash mismatch" });
  });

  it("detects deleted entries", () => {
    const file = fresh();
    const a = new AuditLog(file);
    for (let i = 1; i <= 3; i++) a.append(ev(i, `e${i}`));
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n");
    expect(a.verify()).toMatchObject({ ok: false, brokenAt: 1, reason: "prev hash mismatch" });
  });

  it("redacts registered secrets before they reach the log", () => {
    const file = fresh();
    const bus = new EventBus(new AuditLog(file));
    registerSecret("super-secret-value-123");
    bus.emit({ sessionId: "s", type: "error", actor: "system", text: "key=super-secret-value-123 sk-abcdefghijklmnopqrstuvwxyz" });
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("super-secret-value-123");
    expect(raw).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(raw).toContain("[REDACTED]");
  });
});
