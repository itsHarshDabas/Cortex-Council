import type { CortexConfig, MemberConfig } from "../config.ts";
import { registerSecret } from "../util/redact.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { CliAdapter } from "./cli.ts";
import { GeminiAdapter } from "./gemini.ts";
import { MockAdapter } from "./mock.ts";
import { OpenAIAdapter } from "./openai.ts";
import type { ModelAdapter } from "./types.ts";

export function createAdapter(member: MemberConfig, cfg: CortexConfig): ModelAdapter {
  const a = member.adapter;
  if ("apiKeyEnv" in a && a.apiKeyEnv) registerSecret(process.env[a.apiKeyEnv]);
  switch (a.type) {
    case "mock":
      return new MockAdapter(a);
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
  }
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();

  constructor(private readonly cfg: CortexConfig) {
    for (const m of cfg.members) this.adapters.set(m.id, createAdapter(m, cfg));
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
