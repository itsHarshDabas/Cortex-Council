import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type { CouncilEvent, MemberInfo } from "../../shared/types.ts";
import type { App } from "../app.ts";
import { commandOf } from "../config.ts";
import { ValidationError } from "../orchestrator/sessionManager.ts";

const MAX_BODY = 1_000_000;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[]; url: URL; body: any }) => unknown | Promise<unknown>;
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export interface ServerOptions {
  token?: string;
  staticDir?: string;
}

export function createHttpServer(app: App, opts: ServerOptions = {}): Server {
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler) =>
    routes.push({ method, pattern: new RegExp("^" + path.replace(/:[a-z]+/g, "([^/]+)") + "$"), handler });

  const memberInfo = (): MemberInfo[] =>
    app.cfg.members.map((m) => ({
      id: m.id,
      name: m.name,
      adapter: m.adapter.type,
      model: "model" in m.adapter && m.adapter.model ? m.adapter.model : commandOf(m.adapter),
      roles: m.roles,
      color: m.color ?? "#38bdf8",
      canExecute: Boolean(m.canExecute),
    }));

  const session = (id: string) => {
    const s = app.sessions.get(id);
    if (!s) throw new HttpError(404, "Unknown session.");
    return s;
  };

  route("GET", "/api/health", () => ({ ok: true, name: "cortex-council", version: "0.1.0" }));
  route("GET", "/api/council", () => ({
    members: memberInfo(),
    committees: app.cfg.committees,
    defaults: app.cfg.defaults,
    execution: { workspace: app.executor.worktrees.repo, testCommand: app.cfg.execution.testCommand },
  }));
  route("GET", "/api/adapters/health", () => app.adapters.health());

  route("GET", "/api/sessions", () => app.store.list());
  route("POST", "/api/sessions", ({ body, res }) => {
    res.statusCode = 201;
    return app.sessions.create(body ?? {});
  });
  route("GET", "/api/sessions/:id", ({ params }) => session(params[0]!));
  route("GET", "/api/sessions/:id/events", ({ params }) => app.bus.historyFor(session(params[0]!).id));
  route("POST", "/api/sessions/:id/interject", ({ params, body }) => (app.sessions.interject(params[0]!, String(body?.text ?? "")), { ok: true }));
  for (const action of ["pause", "resume", "abort"] as const) {
    route("POST", `/api/sessions/:id/${action}`, ({ params }) => (app.sessions[action](params[0]!), { ok: true }));
  }
  route("POST", "/api/sessions/:id/approve", ({ params, body }) => {
    app.sessions.decide(params[0]!, { kind: "approve", note: body?.note ? String(body.note) : undefined });
    return { ok: true };
  });
  route("POST", "/api/sessions/:id/reject", ({ params, body }) => {
    app.sessions.decide(params[0]!, { kind: "reject", reason: body?.reason ? String(body.reason) : undefined });
    return { ok: true };
  });
  route("POST", "/api/sessions/:id/amend", ({ params, body }) => {
    app.sessions.decide(params[0]!, { kind: "amend", text: String(body?.text ?? "") });
    return { ok: true };
  });

  route("GET", "/api/audit", ({ url }) => {
    const limit = Math.min(2000, Number(url.searchParams.get("limit") ?? 200) || 200);
    const sid = url.searchParams.get("session");
    const all = app.audit.readAll();
    return (sid ? all.filter((e) => e.sessionId === sid) : all).slice(-limit);
  });
  route("GET", "/api/audit/verify", () => app.audit.verify());

  route("GET", "/api/memory", () => app.memory.all());
  route("POST", "/api/memory", ({ body, res }) => {
    const title = String(body?.title ?? "").trim();
    const content = String(body?.content ?? "").trim();
    if (!title || !content) throw new ValidationError("title and content are required.");
    res.statusCode = 201;
    return app.memory.add({ title: title.slice(0, 200), content: content.slice(0, 5000), tags: Array.isArray(body?.tags) ? body.tags.map(String) : [] });
  });
  route("DELETE", "/api/memory/:id", ({ params }) => {
    if (!app.memory.remove(params[0]!)) throw new HttpError(404, "Unknown memory entry.");
    return { ok: true };
  });

  const staticDir = opts.staticDir && existsSync(opts.staticDir) ? resolve(opts.staticDir) : null;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    try {
      if (url.pathname.startsWith("/api/")) {
        guard(req, url, opts.token);
        if (url.pathname === "/api/stream" && req.method === "GET") return stream(app, req, res, url);
        const match = findRoute(routes, req.method ?? "GET", url.pathname);
        if (!match) throw new HttpError(404, "Not found.");
        const body = req.method === "POST" ? await readJson(req) : undefined;
        const out = await match.route.handler({ req, res, params: match.params, url, body });
        return sendJson(res, res.statusCode || 200, out);
      }
      if (staticDir) return serveStatic(staticDir, url.pathname, res);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Cortex Council API is running. Start the UI with `npm run dev` or build it with `npm run build`.");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof ValidationError ? 400 : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? "Internal error." : (err as Error).message });
    }
  });
}

/** Token auth + DNS-rebinding/CSRF protection for the local API. */
function guard(req: IncomingMessage, url: URL, token?: string) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!token && !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    throw new HttpError(403, "Set CORTEX_TOKEN to accept non-localhost requests.");
  }
  const origin = req.headers.origin;
  if (origin && req.method !== "GET") {
    const o = new URL(origin);
    if (o.host !== req.headers.host && !["localhost", "127.0.0.1"].includes(o.hostname)) throw new HttpError(403, "Cross-origin request refused.");
  }
  if (req.method === "POST" && !(req.headers["content-type"] ?? "").includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
  if (token) {
    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "Missing or invalid token.");
  }
}

function findRoute(routes: Route[], method: string, path: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(path);
    if (m) return { route, params: m.slice(1).map(decodeURIComponent) };
  }
  return null;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body ?? null));
}

/** Server-Sent Events: replays a session's history, then streams live events. */
function stream(app: App, req: IncomingMessage, res: ServerResponse, url: URL) {
  const sid = url.searchParams.get("session");
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (e: CouncilEvent) => res.write(`id: ${e.seq}\nevent: council\ndata: ${JSON.stringify(e)}\n\n`);
  const after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
  if (sid) for (const e of app.bus.historyFor(sid)) if (e.seq > after) send(e);
  res.write(`event: ready\ndata: {}\n\n`);
  const unsubscribe = app.bus.subscribe((e) => {
    if (!sid || e.sessionId === sid) send(e);
  });
  const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

function serveStatic(root: string, pathname: string, res: ServerResponse) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, safe);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
  });
  res.end(readFileSync(file));
}
