import { postJson, resolveKey } from "./http.ts";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.ts";

/** Google Gemini generateContent API. */
export class GeminiAdapter implements ModelAdapter {
  readonly kind = "gemini";
  private readonly baseUrl: string;

  constructor(private readonly cfg: { baseUrl?: string; model: string; apiKeyEnv?: string; apiKey?: string }) {
    this.baseUrl = (cfg.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const json = await postJson(
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.cfg.model)}:generateContent`,
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      },
      { "x-goog-api-key": resolveKey(this.cfg, "GEMINI_API_KEY") },
      req.signal,
    );
    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    return {
      text: parts.map((p: any) => p?.text ?? "").join(""),
      usage: { inputTokens: json?.usageMetadata?.promptTokenCount, outputTokens: json?.usageMetadata?.candidatesTokenCount },
    };
  }

  async health() {
    const ok = Boolean(this.cfg.apiKey || process.env[this.cfg.apiKeyEnv ?? "GEMINI_API_KEY"]);
    return { ok, detail: ok ? this.cfg.model : "API key not set" };
  }
}
