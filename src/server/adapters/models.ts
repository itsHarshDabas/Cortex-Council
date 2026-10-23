import type { ProviderKind, ProviderTestResult } from "../../shared/providers.ts";
import { redact } from "../util/redact.ts";

const MAX_MODELS = 500;

/** The model-list endpoint and auth headers for each wire protocol. */
function modelsRequest(kind: ProviderKind, baseUrl: string, key?: string): { url: string; headers: Record<string, string> } {
  const base = baseUrl.replace(/\/+$/, "");
  switch (kind) {
    case "openai":
      return { url: `${base}/models`, headers: key ? { authorization: `Bearer ${key}` } : {} };
    case "anthropic":
      return { url: `${base}/v1/models?limit=1000`, headers: { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" } };
    case "gemini":
      return { url: `${base}/v1beta/models?pageSize=1000`, headers: { "x-goog-api-key": key ?? "" } };
  }
}

function parseModels(kind: ProviderKind, json: any): string[] {
  if (kind === "gemini") {
    const list: any[] = Array.isArray(json?.models) ? json.models : [];
    return list
      .filter((m) => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => String(m?.name ?? "").replace(/^models\//, ""));
  }
  const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return list.map((m) => String(m?.id ?? m?.name ?? ""));
}

/**
 * "Test connection": list the provider's models. One cheap, read-only call that proves the
 * base URL, the protocol and the key all work, and feeds the model picker. Never throws.
 */
export async function listModels(kind: ProviderKind, baseUrl: string, key?: string, timeoutMs = 8000): Promise<ProviderTestResult> {
  const started = Date.now();
  const { url, headers } = modelsRequest(kind, baseUrl, key);
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? "the key was rejected" : res.status === 404 ? "no model list at this URL; check the base URL" : "request failed";
      return { ok: false, status: res.status, latencyMs, models: [], detail: redact(`HTTP ${res.status}: ${hint}. ${text.slice(0, 200)}`).trim() };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, latencyMs, models: [], detail: "The server answered, but not with JSON. Check the base URL." };
    }
    const models = [...new Set(parseModels(kind, json).filter(Boolean))].sort().slice(0, MAX_MODELS);
    return { ok: true, status: res.status, latencyMs, models, detail: `Connected · ${models.length} model${models.length === 1 ? "" : "s"}` };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const detail = e.name === "TimeoutError" ? `No answer within ${timeoutMs / 1000}s.` : e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
    return { ok: false, latencyMs: Date.now() - started, models: [], detail: redact(detail) };
  }
}
