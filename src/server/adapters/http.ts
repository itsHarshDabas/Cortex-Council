import { AdapterError } from "./types.ts";

export function requireKey(envName: string): string {
  const key = process.env[envName];
  if (!key) throw new AdapterError(`Environment variable ${envName} is not set.`);
  return key;
}

export async function postJson(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new AdapterError(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`, res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new AdapterError(`Non-JSON response from ${new URL(url).host}`);
  }
}
