import { postJson, requireKey } from "./http.ts";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.ts";

/**
 * OpenAI-compatible Chat Completions. Covers OpenAI (ChatGPT models), Ollama
 * (http://localhost:11434/v1), LM Studio, vLLM, OpenRouter, Groq, etc.
 */
export class OpenAIAdapter implements ModelAdapter {
  readonly kind = "openai";
  private readonly baseUrl: string;

  constructor(
    private readonly cfg: { baseUrl?: string; model: string; apiKeyEnv?: string; apiKey?: string; temperature?: number; maxTokens?: number },
  ) {
    this.baseUrl = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    if (this.cfg.apiKey) return { authorization: `Bearer ${this.cfg.apiKey}` };
    return this.cfg.apiKeyEnv ? { authorization: `Bearer ${requireKey(this.cfg.apiKeyEnv)}` } : {};
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const json = await postJson(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.cfg.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
        ...(this.cfg.temperature !== undefined ? { temperature: this.cfg.temperature } : {}),
        ...(this.cfg.maxTokens ? { max_tokens: this.cfg.maxTokens } : {}),
      },
      this.headers(),
      req.signal,
    );
    return {
      text: json?.choices?.[0]?.message?.content ?? "",
      usage: { inputTokens: json?.usage?.prompt_tokens, outputTokens: json?.usage?.completion_tokens },
    };
  }

  async health() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, detail: res.ok ? this.cfg.model : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
