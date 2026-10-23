// API providers managed from the UI. Shared by the server and the web UI; keep dependency-free.
import type { Role } from "./types.ts";

/** Wire protocol a provider speaks. "openai" covers every OpenAI-compatible endpoint. */
export type ProviderKind = "openai" | "anthropic" | "gemini";
export const PROVIDER_KINDS: readonly ProviderKind[] = ["openai", "anthropic", "gemini"];

/** Where a provider's API key comes from. "stored" keys live in <dataDir>/secrets.json (0600), never in config. */
export type KeySource = "none" | "env" | "stored";

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Conventional env var for the key; absent for local servers that need none. */
  apiKeyEnv?: string;
  local?: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" },
  { id: "gemini", name: "Google Gemini", kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKeyEnv: "GEMINI_API_KEY" },
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  { id: "groq", name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
  { id: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { id: "mistral", name: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY" },
  { id: "xai", name: "xAI", kind: "openai", baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY" },
  { id: "together", name: "Together AI", kind: "openai", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" },
  { id: "ollama", name: "Ollama (local)", kind: "openai", baseUrl: "http://localhost:11434/v1", local: true },
  { id: "lmstudio", name: "LM Studio (local)", kind: "openai", baseUrl: "http://localhost:1234/v1", local: true },
];

/** A provider as the UI sees it. Never carries a key. */
export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  keySource: KeySource;
  apiKeyEnv?: string;
  /** keySource "env": whether that variable is set in the server's environment. */
  envPresent?: boolean;
  /** Member ids seated on this provider. */
  members: string[];
  createdAt: string;
  updatedAt: string;
}

/** Create/update body. `apiKey` is write-only: omit it on update to keep the stored key. */
export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  keySource: KeySource;
  apiKeyEnv?: string;
  apiKey?: string;
}

/** Test body: a draft provider, or `id` alone to test a saved one (its stored key is reused if no key is given). */
export type ProviderTestInput = Partial<ProviderInput> & { id?: string };

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  models: string[];
  detail: string;
}

/** A council member seated on a UI-managed provider. */
export interface SeatInput {
  id?: string;
  name: string;
  provider: string;
  model: string;
  roles: Role[];
  persona?: string;
  color?: string;
  committees?: string[];
  temperature?: number;
  maxTokens?: number;
}

export interface SeatView extends Required<Pick<SeatInput, "name" | "provider" | "model" | "roles">> {
  id: string;
  persona?: string;
  color?: string;
  committees: string[];
  temperature?: number;
  maxTokens?: number;
}
