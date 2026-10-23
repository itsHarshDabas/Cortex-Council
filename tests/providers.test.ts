import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listModels } from "../src/server/adapters/models.ts";
import { createApp } from "../src/server/app.ts";
import { createHttpServer } from "../src/server/http/server.ts";
import { testConfig } from "./helpers.ts";

const KEY = "sk-test-0123456789abcdefSECRET";
const KEY2 = "sk-test-rotated-9876543210ROTATED";

/** A fake provider that speaks the OpenAI, Anthropic and Gemini model-list + chat endpoints. */
const seen: { path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let fake: Server;
let fakeUrl: string;

beforeAll(async () => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const auth = req.headers.authorization ?? "";
      if (req.url === "/v1/models") {
        if (auth !== `Bearer ${KEY}` && auth !== `Bearer ${KEY2}`) return json(401, { error: `invalid key ${auth.slice(7)}` });
        return json(200, { data: [{ id: "llama-3.3-70b" }, { id: "mixtral-8x7b" }, { id: "llama-3.3-70b" }] });
      }
      if (req.url === "/v1/chat/completions") return json(200, { choices: [{ message: { content: "Aye." } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
      if (req.url?.startsWith("/v1/models?limit=")) return json(200, { data: [{ id: "claude-opus-5-5" }] });
      if (req.url?.startsWith("/v1beta/models")) {
        return json(200, {
          models: [
            { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
            { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
          ],
        });
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => fake.close(() => r())));

describe("listModels", () => {
  it("lists OpenAI-compatible models with a bearer key, deduped and sorted", async () => {
    const r = await listModels("openai", `${fakeUrl}/v1`, KEY);
    expect(r).toMatchObject({ ok: true, status: 200, models: ["llama-3.3-70b", "mixtral-8x7b"] });
    expect(seen.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("explains a rejected key without echoing it", async () => {
    const r = await listModels("openai", `${fakeUrl}/v1`, "sk-wrong-key-abcdefghijklmnop");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.detail).toMatch(/key was rejected/);
    expect(r.detail).not.toContain("sk-wrong-key-abcdefghijklmnop");
  });

  it("speaks the Anthropic and Gemini model-list protocols", async () => {
    const a = await listModels("anthropic", fakeUrl, "anthropic-key-123456");
    expect(a.models).toEqual(["claude-opus-5-5"]);
    expect(seen.at(-1)!.headers["x-api-key"]).toBe("anthropic-key-123456");
    expect(seen.at(-1)!.headers["anthropic-version"]).toBeTruthy();
    const g = await listModels("gemini", fakeUrl, "gemini-key-1234567");
    expect(g.models).toEqual(["gemini-2.5-pro"]); // embedding-only models are filtered out
    expect(seen.at(-1)!.headers["x-goog-api-key"]).toBe("gemini-key-1234567");
  });

  it("reports unreachable hosts instead of throwing", async () => {
    const r = await listModels("openai", "http://127.0.0.1:1/v1", undefined, 2000);
    expect(r.ok).toBe(false);
    expect(r.detail).toBeTruthy();
  });
});

describe("providers API", () => {
  const cfg = testConfig();
  const app = createApp(cfg);
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createHttpServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const send = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (method: string, path: string, body?: unknown) => {
    const res = await send(method, path, body);
    return { status: res.status, body: await res.json(), raw: res };
  };

  it("validates provider input", async () => {
    expect((await json("POST", "/providers", { name: "x", kind: "openai", baseUrl: "ftp://x", keySource: "none" })).status).toBe(400);
    expect((await json("POST", "/providers", { name: "x", kind: "openai", baseUrl: "https://u:p@x.com/v1", keySource: "none" })).body.error).toMatch(/credentials/);
    expect((await json("POST", "/providers", { name: "x", kind: "anthropic", keySource: "none" })).body.error).toMatch(/needs an API key/);
    expect((await json("POST", "/providers", { name: "x", kind: "openai", keySource: "env", apiKeyEnv: "BAD NAME" })).status).toBe(400);
    expect((await json("POST", "/providers", { name: "x", kind: "openai", keySource: "stored", apiKey: "short" })).status).toBe(400);
    expect((await json("POST", "/providers", { name: "x", kind: "mystery", keySource: "none" })).status).toBe(400);
  });

  it("requires JSON for PUT (CSRF guard)", async () => {
    const res = await fetch(`${base}/providers/x`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(res.status).toBe(415);
  });

  it("stores a pasted key owner-only and never returns, logs or audits it", async () => {
    const created = await json("POST", "/providers", { name: "Groq", kind: "openai", baseUrl: `${fakeUrl}/v1/`, keySource: "stored", apiKey: KEY });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "groq", keySource: "stored", baseUrl: `${fakeUrl}/v1` });
    expect(JSON.stringify(created.body)).not.toContain(KEY);

    const listed = await send("GET", "/providers");
    expect(await listed.text()).not.toContain(KEY);

    const dir = app.cfg.dataDir;
    expect(readFileSync(join(dir, "providers.json"), "utf8")).not.toContain(KEY);
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).toContain(KEY);
    if (process.platform !== "win32") expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".gitignore"), "utf8").trim()).toBe("*");
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toContain("provider.saved");
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain(KEY);
  });

  it("tests a saved provider with its stored key, and a draft before saving", async () => {
    const saved = await json("POST", "/providers/test", { id: "groq" });
    expect(saved.body).toMatchObject({ ok: true, models: ["llama-3.3-70b", "mixtral-8x7b"] });
    const draft = await json("POST", "/providers/test", { kind: "openai", baseUrl: `${fakeUrl}/v1`, keySource: "stored", apiKey: "sk-nope-000000000000000000" });
    expect(draft.body.ok).toBe(false);
    expect(JSON.stringify(draft.body)).not.toContain("sk-nope-000000000000000000");
    const env = await json("POST", "/providers/test", { kind: "openai", baseUrl: `${fakeUrl}/v1`, keySource: "env", apiKeyEnv: "CORTEX_TEST_UNSET_KEY" });
    expect(env.body).toMatchObject({ ok: false, detail: expect.stringMatching(/CORTEX_TEST_UNSET_KEY is not set/) });
  });

  it("seats a model live: it joins the council and committee and calls the provider with the key", async () => {
    const seated = await json("POST", "/seats", { name: "Groq Llama", provider: "groq", model: "llama-3.3-70b", roles: ["skeptic"], committees: ["full"], temperature: 0.3 });
    expect(seated.status).toBe(201);
    expect(seated.body.id).toBe("groq-llama");

    const council = (await json("GET", "/council")).body;
    expect(council.members.find((m: any) => m.id === "groq-llama")).toMatchObject({ adapter: "provider", model: "llama-3.3-70b", managed: true, provider: "groq", canExecute: false });
    expect(council.committees.find((c: any) => c.id === "full").members).toContain("groq-llama");

    const out = await app.adapters.get("groq-llama").complete({ system: "s", prompt: "p", meta: { phase: "proposal", memberId: "groq-llama", roles: [], round: 1, task: "t" } });
    expect(out.text).toBe("Aye.");
    const call = seen.at(-1)!;
    expect(call.path).toBe("/v1/chat/completions");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(call.body)).toMatchObject({ model: "llama-3.3-70b", temperature: 0.3 });

    const health = (await json("GET", "/adapters/health")).body;
    expect(health["groq-llama"].ok).toBe(true);
  });

  it("refuses executor roles, duplicate ids and unknown committees for seats", async () => {
    expect((await json("POST", "/seats", { name: "X", provider: "groq", model: "m", roles: ["executor"] })).status).toBe(400);
    expect((await json("POST", "/seats", { id: "atlas", name: "X", provider: "groq", model: "m", roles: [] })).status).toBe(400);
    expect((await json("POST", "/seats", { name: "X", provider: "groq", model: "m", roles: [], committees: ["nope"] })).status).toBe(400);
    expect((await json("POST", "/seats", { name: "X", provider: "ghost", model: "m", roles: [] })).status).toBe(400);
    expect((await json("PUT", "/seats/atlas", { model: "m" })).body.error).toMatch(/cortex.config.json/);
  });

  it("rotates a key and rebuilds seated adapters without a restart", async () => {
    const updated = await json("PUT", "/providers/groq", { apiKey: KEY2 });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).not.toContain(KEY2);
    await app.adapters.get("groq-llama").complete({ system: "s", prompt: "p", meta: { phase: "proposal", memberId: "groq-llama", roles: [], round: 1, task: "t" } });
    expect(seen.at(-1)!.headers.authorization).toBe(`Bearer ${KEY2}`);
    expect(readFileSync(join(app.cfg.dataDir, "audit.jsonl"), "utf8")).not.toContain(KEY2);
  });

  it("edits a seat: model change and leaving a committee", async () => {
    const res = await json("PUT", "/seats/groq-llama", { model: "mixtral-8x7b", committees: [] });
    expect(res.body).toMatchObject({ model: "mixtral-8x7b", committees: [] });
    expect(app.cfg.committees.find((c) => c.id === "full")!.members).not.toContain("groq-llama");
    expect(app.cfg.members.find((m) => m.id === "groq-llama")!.adapter).toMatchObject({ model: "mixtral-8x7b" });
  });

  it("survives a restart: seats and keys are reloaded from the data dir", () => {
    const again = createApp({ ...cfg, dataDir: app.cfg.dataDir });
    expect(again.cfg.members.map((m) => m.id)).toContain("groq-llama");
    expect(again.providerStore.resolve("groq")).toMatchObject({ apiKey: KEY2 });
  });

  it("won't remove a provider that still has seats; unseat, then remove deletes the key", async () => {
    expect((await json("DELETE", "/providers/groq")).status).toBe(409);
    expect((await json("DELETE", "/seats/groq-llama")).status).toBe(200);
    expect(app.cfg.members.some((m) => m.id === "groq-llama")).toBe(false);
    expect((await json("DELETE", "/providers/groq")).status).toBe(200);
    expect(readFileSync(join(app.cfg.dataDir, "secrets.json"), "utf8")).not.toContain(KEY2);
    expect((await json("GET", "/providers")).body.providers).toEqual([]);
  });

  it("switching a provider to an env var drops its stored key", async () => {
    await json("POST", "/providers", { name: "Mistral", kind: "openai", keySource: "stored", apiKey: KEY });
    process.env.CORTEX_TEST_MISTRAL_KEY = "x";
    const res = await json("PUT", "/providers/mistral", { keySource: "env", apiKeyEnv: "CORTEX_TEST_MISTRAL_KEY" });
    delete process.env.CORTEX_TEST_MISTRAL_KEY;
    expect(res.body).toMatchObject({ keySource: "env", apiKeyEnv: "CORTEX_TEST_MISTRAL_KEY", envPresent: true });
    expect(readFileSync(join(app.cfg.dataDir, "secrets.json"), "utf8")).not.toContain(KEY);
  });
});
