import { join, resolve } from "node:path";
import { AdapterRegistry } from "./adapters/registry.ts";
import type { CortexConfig } from "./config.ts";
import { AuditLog } from "./core/audit.ts";
import { EventBus } from "./core/eventBus.ts";
import { ProjectMemory } from "./core/memory.ts";
import { SessionStore } from "./core/store.ts";
import { ExecutionService } from "./execution/executor.ts";
import { SessionManager } from "./orchestrator/sessionManager.ts";

export interface App {
  cfg: CortexConfig;
  adapters: AdapterRegistry;
  audit: AuditLog;
  bus: EventBus;
  store: SessionStore;
  memory: ProjectMemory;
  executor: ExecutionService;
  sessions: SessionManager;
}

/** Wire the object graph. Kept separate from the HTTP layer so tests can drive it directly. */
export function createApp(cfg: CortexConfig): App {
  const dataDir = resolve(cfg.dataDir);
  cfg = { ...cfg, dataDir };
  const adapters = new AdapterRegistry(cfg);
  const audit = new AuditLog(join(dataDir, "audit.jsonl"));
  const bus = new EventBus(audit);
  const store = new SessionStore(join(dataDir, "sessions"));
  const memory = new ProjectMemory(join(dataDir, "memory.json"));
  const executor = new ExecutionService(cfg, adapters);
  const sessions = new SessionManager({ cfg, adapters, bus, store, memory, executor });
  return { cfg, adapters, audit, bus, store, memory, executor, sessions };
}
