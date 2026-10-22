import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionStatus } from "../src/shared/types.ts";
import { createApp, type App } from "../src/server/app.ts";
import { defaultConfig, type CortexConfig } from "../src/server/config.ts";

export function testConfig(patch: (c: CortexConfig) => void = () => {}): CortexConfig {
  const cfg = defaultConfig();
  cfg.dataDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
  for (const m of cfg.members) m.adapter = { type: "mock", latencyMs: 0 };
  cfg.defaults.timeoutMs = 5000;
  cfg.defaults.retries = 0;
  patch(cfg);
  return cfg;
}

export function testApp(patch?: (c: CortexConfig) => void): App {
  return createApp(testConfig(patch));
}

export async function waitFor(app: App, id: string, statuses: SessionStatus[], timeoutMs = 15000): Promise<Session> {
  const start = Date.now();
  for (;;) {
    const s = app.sessions.get(id);
    if (s && statuses.includes(s.status)) return s;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${statuses.join("|")}; status is ${s?.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const motion = { title: "Add rate limiting", task: "Add rate limiting to the public API. Keep existing clients working." };
