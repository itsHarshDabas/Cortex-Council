import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createHttpServer } from "../src/server/http/server.ts";
import { motion, testApp, waitFor } from "./helpers.ts";

const app = testApp();
const TOKEN = "test-token-1234567890";
let server: Server;
let base: string;

beforeAll(async () => {
  server = createHttpServer(app, { token: TOKEN });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const auth = { authorization: `Bearer ${TOKEN}` };
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("HTTP API", () => {
  it("requires the token", async () => {
    expect((await fetch(`${base}/council`)).status).toBe(401);
    expect((await fetch(`${base}/council`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await fetch(`${base}/council`, { headers: auth });
    expect(ok.status).toBe(200);
    expect((await ok.json()).members).toHaveLength(5);
  });

  it("rejects non-JSON posts (CSRF guard)", async () => {
    const res = await fetch(`${base}/sessions`, { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" });
    expect(res.status).toBe(415);
  });

  it("rejects cross-origin writes", async () => {
    const res = await post("/sessions", motion, { ...auth, origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("validates input", async () => {
    const res = await post("/sessions", { title: "" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/title/);
  });

  it("drives a session end to end over REST and streams events over SSE", async () => {
    const created = await post("/sessions", motion);
    expect(created.status).toBe(201);
    const { id } = await created.json();

    const ctrl = new AbortController();
    const stream = await fetch(`${base}/stream?session=${id}&token=${TOKEN}`, { signal: ctrl.signal });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    let text = "";
    while (!text.includes("plan.synthesized")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    expect(text).toContain("proposal.submitted");
    expect(text).toContain("consensus.computed");

    await waitFor(app, id, ["awaiting_approval"]);
    expect((await post(`/sessions/${id}/approve`, {})).status).toBe(200);
    await waitFor(app, id, ["completed"]);
    expect((await post(`/sessions/${id}/approve`, {})).status).toBe(400);

    const verify = await (await fetch(`${base}/audit/verify`, { headers: auth })).json();
    expect(verify.ok).toBe(true);
    const audit = await (await fetch(`${base}/audit?session=${id}`, { headers: auth })).json();
    expect(audit.some((e: { type: string }) => e.type === "architect.approved")).toBe(true);
  });

  it("manages project memory", async () => {
    const add = await post("/memory", { title: "Use SQLite later", content: "Files are fine for the MVP." });
    expect(add.status).toBe(201);
    const { id } = await add.json();
    const list = await (await fetch(`${base}/memory`, { headers: auth })).json();
    expect(list.some((m: { id: string }) => m.id === id)).toBe(true);
    expect((await fetch(`${base}/memory/${id}`, { method: "DELETE", headers: auth })).status).toBe(200);
  });
});
