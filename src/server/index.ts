import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createHttpServer } from "./http/server.ts";
import { registerSecret } from "./util/redact.ts";

function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const token = process.env.CORTEX_TOKEN || undefined;
  registerSecret(token);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(cfg.server.host);
  if (!loopback && !token) {
    console.error("Refusing to bind to a non-loopback address without CORTEX_TOKEN set.");
    process.exit(1);
  }

  const app = createApp(cfg);
  const server = createHttpServer(app, { token, staticDir: fileURLToPath(new URL("../../dist/web", import.meta.url)) });
  server.listen(cfg.server.port, cfg.server.host, () => {
    const mocks = cfg.members.filter((m) => m.adapter.type === "mock").length;
    console.log(`\n  ◆ Cortex Council is in session at http://${cfg.server.host}:${cfg.server.port}`);
    console.log(`    ${cfg.members.length} members (${mocks} mock) · data in ${app.cfg.dataDir}${token ? " · token auth on" : ""}\n`);
  });

  const shutdown = () => {
    console.log("\nAdjourning the council…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
