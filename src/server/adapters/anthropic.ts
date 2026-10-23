import { postJson, resolveKey } from "./http.ts";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.ts";

/** Anthropic Messages API (Claude models). */
export class AnthropicAdapter implements ModelAdapter {
  readonly kind = "anthropic";
  private readonly baseUrl: string;

  constructor(private readonly cfg: { baseUrl?: string; model: string; apiKeyEnv?: string; apiKey?: string; maxTokens?: number }) {
    this.baseUrl = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const json = await postJson(
      `${this.baseUrl}/v1/messages`,
      {
        model: this.cfg.model,
        max_tokens: this.cfg.maxTokens ?? 4096,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      },
      {
        "x-api-key": resolveKey(this.cfg, "ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
      },
      req.signal,
    );
    const text = Array.isArray(json?.content)
      ? json.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("")
      : "";
    return { text, usage: { inputTokens: json?.usage?.input_tokens, outputTokens: json?.usage?.output_tokens } };
  }

  async health() {
    const ok = Boolean(this.cfg.apiKey || process.env[this.cfg.apiKeyEnv ?? "ANTHROPIC_API_KEY"]);
    return { ok, detail: ok ? this.cfg.model : "API key not set" };
  }
}
