import { ConfigError, type CortexConfig, type MemberConfig } from "../config.ts";
import type { ResolvedProvider } from "../core/providers.ts";
import { registerSecret } from "../util/redact.ts";
import { AgentCliAdapter } from "./agentCli.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { CliAdapter } from "./cli.ts";
import { GeminiAdapter } from "./gemini.ts";
import { OpenAIAdapter } from "./openai.ts";
import type { ModelAdapter } from "./types.ts";

export type ProviderResolver = (id: string) => ResolvedProvider | undefined;
/** Builds an adapter before the built-in types are tried; return undefined to fall through. Used by tests for fixtures. */
export type AdapterFactory = (member: MemberConfig, cfg: CortexConfig) => ModelAdapter | undefined;

export function createAdapter(member: MemberConfig, cfg: CortexConfig, resolveProvider?: ProviderResolver): ModelAdapter {
  const a = member.adapter;
  if ("apiKeyEnv" in a && a.apiKeyEnv) registerSecret(process.env[a.apiKeyEnv]);
  switch (a.type) {
    case "openai":
      return new OpenAIAdapter(a);
    case "anthropic":
      registerSecret(process.env[a.apiKeyEnv ?? "ANTHROPIC_API_KEY"]);
      return new AnthropicAdapter(a);
    case "gemini":
      registerSecret(process.env[a.apiKeyEnv ?? "GEMINI_API_KEY"]);
      return new GeminiAdapter(a);
    case "cli":
      return new CliAdapter(a, cfg.execution.allowedCommands, cfg.defaults.timeoutMs);
    case "opencode":
    case "kilo":
    case "cline":
    case "freebuff":
      return new AgentCliAdapter(a, cfg.execution.allowedCommands, cfg.defaults.timeoutMs);
    case "provider": {
      const p = resolveProvider?.(a.provider);
      if (!p) throw new ConfigError(`Member "${member.id}" uses unknown provider "${a.provider}".`);
      registerSecret(p.apiKey ?? (p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined));
      const common = { baseUrl: p.baseUrl, model: a.model, apiKey: p.apiKey, apiKeyEnv: p.apiKeyEnv };
      if (p.kind === "anthropic") return new AnthropicAdapter({ ...common, maxTokens: a.maxTokens });
      if (p.kind === "gemini") return new GeminiAdapter(common);
      return new OpenAIAdapter({ ...common, temperature: a.temperature, maxTokens: a.maxTokens });
    }
  }
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();

  constructor(
    private readonly cfg: CortexConfig,
    private readonly resolveProvider?: ProviderResolver,
    private readonly factory?: AdapterFactory,
  ) {
    for (const m of cfg.members) this.load(m);
  }

  /** (Re)build a member's adapter, e.g. after its provider's URL or key changed. */
  load(member: MemberConfig): void {
    this.adapters.set(member.id, this.factory?.(member, this.cfg) ?? createAdapter(member, this.cfg, this.resolveProvider));
  }

  delete(memberId: string): void {
    this.adapters.delete(memberId);
  }

  get(memberId: string): ModelAdapter {
    const a = this.adapters.get(memberId);
    if (!a) throw new Error(`No adapter for member "${memberId}".`);
    return a;
  }

  /** Test hook: swap an adapter (e.g. a failing one). */
  set(memberId: string, adapter: ModelAdapter): void {
    this.adapters.set(memberId, adapter);
  }

  async health(): Promise<Record<string, { ok: boolean; detail?: string }>> {
    const out: Record<string, { ok: boolean; detail?: string }> = {};
    await Promise.all(
      this.cfg.members.map(async (m) => {
        out[m.id] = await this.get(m.id).health().catch((e: Error) => ({ ok: false, detail: e.message }));
      }),
    );
    return out;
  }
}
