import { join, resolve } from "node:path";
import { type AdapterFactory, AdapterRegistry } from "./adapters/registry.ts";
import type { CortexConfig } from "./config.ts";
import { AuditLog } from "./core/audit.ts";
import { EventBus } from "./core/eventBus.ts";
import { ProjectMemory } from "./core/memory.ts";
import { mergeSeats, ProviderService } from "./core/providerService.ts";
import { ProviderStore } from "./core/providers.ts";
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
  providerStore: ProviderStore;
  providers: ProviderService;
}

/** Wire the object graph. Kept separate from the HTTP layer so tests can drive it directly. */
export function createApp(cfg: CortexConfig, opts: { adapterFactory?: AdapterFactory } = {}): App {
  const dataDir = resolve(cfg.dataDir);
  // Members and committees are mutated live when seats change, so give this app its own copies.
  cfg = { ...cfg, dataDir, members: [...cfg.members], committees: cfg.committees.map((c) => ({ ...c, members: [...c.members] })) };
  const providerStore = new ProviderStore(dataDir);
  for (const id of mergeSeats(cfg, providerStore)) console.warn(`Skipping UI seat "${id}": cortex.config.json already has a member with that id.`);
  const adapters = new AdapterRegistry(cfg, (id) => providerStore.resolve(id), opts.adapterFactory);
  const audit = new AuditLog(join(dataDir, "audit.jsonl"));
  const bus = new EventBus(audit);
  const store = new SessionStore(join(dataDir, "sessions"));
  const memory = new ProjectMemory(join(dataDir, "memory.json"));
  const executor = new ExecutionService(cfg, adapters);
  const sessions = new SessionManager({ cfg, adapters, bus, store, memory, executor });
  const providers = new ProviderService({ cfg, adapters, store: providerStore, bus, sessions });
  return { cfg, adapters, audit, bus, store, memory, executor, sessions, providerStore, providers };
}
