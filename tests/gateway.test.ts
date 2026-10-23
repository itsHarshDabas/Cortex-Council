import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserCommand, browserUrl, cortexHome, parseArgs, probe, ROOT, serverAddress } from "../scripts/gateway.mjs";

describe("gateway arguments", () => {
  it("opens by default", () => {
    expect(parseArgs([])).toMatchObject({ command: "open", open: true, detach: false });
  });
  it("start never opens a tab", () => {
    expect(parseArgs(["start", "--detach"])).toMatchObject({ command: "start", open: false, detach: true });
  });
  it("reads --port in both forms and rejects bad ones", () => {
    expect(parseArgs(["--port", "8000"]).port).toBe(8000);
    expect(parseArgs(["--port=8001"]).port).toBe(8001);
    expect(() => parseArgs(["--port", "99999"])).toThrow(/Invalid port/);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("gateway home and address", () => {
  it("uses the checkout when writable, else a per-user folder", () => {
    expect(cortexHome({}, "linux", () => true)).toBe(ROOT);
    expect(cortexHome({ CORTEX_HOME: "/x/y" }, "linux", () => false)).toBe("/x/y");
    expect(cortexHome({ XDG_DATA_HOME: "/data" }, "linux", () => false)).toBe(join("/data", "cortex-council"));
    expect(cortexHome({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32", () => false)).toMatch(/cortex-council$/);
    expect(cortexHome({}, "darwin", () => false)).toMatch(/Application Support[\\/]cortex-council$/);
  });

  it("follows cortex.config.json, then the env overrides", () => {
    const home = mkdtempSync(join(tmpdir(), "cortex-gw-"));
    expect(serverAddress(home, {})).toEqual({ host: "127.0.0.1", port: 7420 });
    writeFileSync(join(home, "cortex.config.json"), JSON.stringify({ server: { port: 9100 } }));
    expect(serverAddress(home, {})).toEqual({ host: "127.0.0.1", port: 9100 });
    expect(serverAddress(home, { CORTEX_PORT: "9200" }).port).toBe(9200);
  });

  it("points the browser at loopback for wildcard binds", () => {
    expect(browserUrl("0.0.0.0", 7420)).toBe("http://127.0.0.1:7420");
    expect(browserUrl("192.168.1.5", 80)).toBe("http://192.168.1.5:80");
    expect(browserUrl("fd00::1", 80)).toBe("http://[fd00::1]:80");
  });

  it("opens the browser the native way on each OS", () => {
    expect(browserCommand("http://x", "win32").cmd).toBe("rundll32");
    expect(browserCommand("http://x", "darwin").cmd).toBe("open");
    expect(browserCommand("http://x", "linux").cmd).toBe("xdg-open");
  });
});

describe("gateway probe", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  const serve = (status: number, body: unknown) =>
    new Promise<string>((resolve) => {
      server = createServer((_, res) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)));
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
    });

  it("recognizes Cortex Council, with or without a token", async () => {
    expect(await probe(await serve(200, { ok: true, name: "cortex-council" }), "")).toBe("running");
    server!.close();
    expect(await probe(await serve(401, { error: "Missing or invalid token." }), "")).toBe("running");
  });

  it("tells another app on the port apart from a free port", async () => {
    const url = await serve(200, { hello: "world" });
    expect(await probe(url, "")).toBe("other");
    await new Promise((r) => server!.close(r));
    server = undefined;
    expect(await probe(url, "")).toBe("stopped");
  });
});
