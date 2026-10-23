import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionStatus } from "../src/shared/types.ts";
import type { AdapterFactory } from "../src/server/adapters/registry.ts";
import { createApp, type App } from "../src/server/app.ts";
import { type AdapterConfig, type CortexConfig, defaultConfig, type MemberConfig } from "../src/server/config.ts";
import { MockAdapter } from "./fixtures/mockAdapter.ts";

/** Test-only adapter config. The product has no mock adapter; `mockFactory` builds these. */
export const mock = (latencyMs = 0): AdapterConfig => ({ type: "mock", latencyMs }) as unknown as AdapterConfig;

export const mockFactory: AdapterFactory = (m) => {
  const a = m.adapter as unknown as { type: string; latencyMs?: number; failRate?: number };
  return a.type === "mock" ? new MockAdapter(a) : undefined;
};

const member = (id: string, name: string, roles: MemberConfig["roles"], persona: string, canExecute = false): MemberConfig => ({
  id,
  name,
  roles,
  persona,
  canExecute,
  adapter: mock(),
});

/** A five-seat council of deterministic fixture members, shaped to exercise the whole protocol. */
export function testConfig(patch: (c: CortexConfig) => void = () => {}): CortexConfig {
  const cfg = defaultConfig();
  cfg.dataDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
  cfg.members = [
    member("atlas", "Atlas", ["strategist"], "Big-picture strategist."),
    member("nyx", "Nyx", ["skeptic"], "Professional skeptic."),
    member("forge", "Forge", ["engineer", "executor"], "Pragmatic senior engineer.", true),
    member("aegis", "Aegis", ["security"], "Security and reliability reviewer."),
    member("lumen", "Lumen", ["speaker", "reviewer"], "Impartial speaker."),
  ];
  cfg.committees = [
    { id: "full", name: "Full Parliament", description: "Everyone.", members: ["atlas", "nyx", "forge", "aegis", "lumen"] },
    { id: "engineering", name: "Engineering Committee", description: "Design.", members: ["atlas", "forge", "nyx"] },
    { id: "security", name: "Security Review Board", description: "Threats.", members: ["aegis", "nyx", "forge"] },
  ];
  cfg.defaults.speaker = "lumen";
  cfg.defaults.reviewer = "aegis";
  cfg.defaults.timeoutMs = 5000;
  cfg.defaults.retries = 0;
  patch(cfg);
  return cfg;
}

export function testApp(patch?: (c: CortexConfig) => void): App {
  return createApp(testConfig(patch), { adapterFactory: mockFactory });
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

/** testConfig() with real adapter types, for code paths that run validateConfig (which rejects the fixture type). */
export const validConfig = () => testConfig((c) => c.members.forEach((m) => (m.adapter = { type: "opencode" })));
