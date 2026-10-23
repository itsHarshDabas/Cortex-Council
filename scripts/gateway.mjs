// The Cortex Council gateway: makes sure the local server is running, then opens it in a browser tab.
// Plain Node (no dependencies) so it works before `npm install` and on Windows, macOS and Linux alike.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage: cortex-council [open | start | stop | status] [options]

  open     Start the server if it isn't running, then open it in the browser (default)
  start    Start the server if it isn't running, without opening the browser
  stop     Stop a server started with --detach
  status   Say whether the server is running

Options:
  --detach      Keep the server running in the background after this command exits
                (log: <data dir>/gateway.log). Without it, Ctrl+C or closing the window stops it.
  --port <n>    Port to use (default: server.port from cortex.config.json, else 7420)
  --no-open     Same as "start"
  -h, --help    Show this help

Config, .env and data are read from CORTEX_HOME: the checkout itself when it is writable,
otherwise a per-user folder (see the README).`;

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ command: string, detach: boolean, open: boolean, port?: number, help: boolean }} */
  const opts = { command: "open", detach: false, open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--detach") opts.detach = true;
    else if (a === "--no-open") opts.open = false;
    else if (a === "--port" || a.startsWith("--port=")) {
      const v = a.includes("=") ? a.slice(7) : argv[++i];
      const port = Number(v);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port "${v}".`);
      opts.port = port;
    } else if (["open", "start", "stop", "status"].includes(a)) opts.command = a;
    else throw new Error(`Unknown argument "${a}".`);
  }
  if (opts.command === "start") opts.open = false;
  return opts;
}

/**
 * Where config, .env and data live. A git checkout keeps them next to the code (like `npm start`);
 * a read-only install (a system package, a global npm install) uses a per-user folder instead.
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @param {(dir: string) => boolean} writable
 */
export function cortexHome(env = process.env, platform = process.platform, writable = isWritable) {
  if (env.CORTEX_HOME) return resolve(env.CORTEX_HOME);
  if (writable(ROOT)) return ROOT;
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "cortex-council");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "cortex-council");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "cortex-council");
}

/** @param {string} dir */
function isWritable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The address the server will bind, resolved the same way as src/server/config.ts.
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 */
export function serverAddress(home, env = process.env) {
  let host = "127.0.0.1";
  let port = 7420;
  const file = resolve(home, env.CORTEX_CONFIG ?? "cortex.config.json");
  if (existsSync(file)) {
    try {
      const server = JSON.parse(readFileSync(file, "utf8")).server ?? {};
      if (typeof server.host === "string") host = server.host;
      if (server.port != null) port = Number(server.port);
    } catch {
      // The server reports invalid config with a proper message when it starts.
    }
  }
  if (env.CORTEX_PORT) port = Number(env.CORTEX_PORT);
  if (env.CORTEX_HOST) host = env.CORTEX_HOST;
  return { host, port };
}

/** The URL a browser on this machine should use for a server bound to `host`. */
export function browserUrl(host, port) {
  const local = ["0.0.0.0", "::", "127.0.0.1", "localhost", "::1"].includes(host);
  const h = local ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/**
 * Is Cortex Council answering at `url`?
 * @returns {Promise<"running" | "stopped" | "other">} "other" means something else holds the port.
 */
export async function probe(url, token = process.env.CORTEX_TOKEN) {
  try {
    const res = await fetch(`${url}/api/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.name === "cortex-council") return "running";
    // With CORTEX_TOKEN set on the server, the health check needs the token too.
    if (res.status === 401 && typeof body?.error === "string" && body.error.includes("token")) return "running";
    return "other";
  } catch (err) {
    const code = /** @type {any} */ (err)?.cause?.code;
    return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EADDRNOTAVAIL" ? "stopped" : "other";
  }
}

/** The command that opens `url` in the default browser. */
export function browserCommand(url, platform = process.platform) {
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

function openBrowser(url) {
  const { cmd, args } = browserCommand(url);
  console.log(`  Opening ${url}`);
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`  Open ${url} in your browser.`));
  child.unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** npm is npm.cmd on Windows, which Node only spawns through a shell. */
function npm(args) {
  console.log(`  › npm ${args.join(" ")}`);
  const r = spawnSync("npm", args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed. Run it in ${ROOT} to see why.`);
}

/** First run from a fresh clone: install dependencies and build the UI. */
function ensureInstalled() {
  const haveDeps = existsSync(join(ROOT, "node_modules", "tsx"));
  const haveUi = existsSync(join(ROOT, "dist", "web", "index.html"));
  if (haveDeps && haveUi) return;
  if (!isWritable(ROOT)) throw new Error(`Cortex Council in ${ROOT} is incomplete (missing ${haveDeps ? "the built UI" : "node_modules"}). Reinstall it.`);
  console.log("  First run: setting up Cortex Council…");
  if (!haveDeps) npm([existsSync(join(ROOT, "package-lock.json")) ? "ci" : "install"]);
  if (!haveUi) npm(["run", "build"]);
}

function pidFile(home) {
  return join(home, ".cortex", "gateway.pid");
}

/** Start the server; resolves once it answers, with the child process. */
async function startServer(home, url, port, detach) {
  ensureInstalled();
  mkdirSync(join(home, ".cortex"), { recursive: true });
  const tsx = import.meta.resolve("tsx");
  const args = ["--env-file-if-exists=.env", "--import", tsx, join(ROOT, "src", "server", "index.ts")];
  const env = { ...process.env, CORTEX_PORT: String(port) };
  let stdio = /** @type {any} */ ("inherit");
  if (detach) {
    const log = openSync(join(home, ".cortex", "gateway.log"), "a");
    stdio = ["ignore", log, log];
  }
  const child = spawn(process.execPath, args, { cwd: home, env, stdio, detached: detach, windowsHide: detach });
  let exited = false;
  child.on("exit", () => (exited = true));
  for (let i = 0; i < 100 && !exited; i++) {
    if ((await probe(url)) === "running") {
      if (detach) {
        writeFileSync(pidFile(home), String(child.pid));
        child.unref();
      }
      return child;
    }
    await sleep(300);
  }
  if (!exited) child.kill();
  throw new Error(`The server didn't start.${detach ? ` See ${join(home, ".cortex", "gateway.log")}.` : ""}`);
}

function stop(home) {
  const file = pidFile(home);
  if (!existsSync(file)) return console.log("  No background server was started with --detach.");
  const pid = Number(readFileSync(file, "utf8"));
  rmSync(file);
  try {
    process.kill(pid, "SIGTERM");
    console.log("  Cortex Council stopped.");
  } catch {
    console.log("  It had already stopped.");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) return console.log(USAGE);
  const home = cortexHome();
  mkdirSync(home, { recursive: true });
  const addr = serverAddress(home);
  const port = opts.port ?? addr.port;
  const url = browserUrl(addr.host, port);

  if (opts.command === "stop") return stop(home);
  const state = await probe(url);
  if (opts.command === "status") {
    console.log(state === "running" ? `  Cortex Council is running at ${url}` : state === "other" ? `  Something else is using ${url}` : "  Cortex Council is not running.");
    process.exitCode = state === "running" ? 0 : 1;
    return;
  }
  if (state === "other") throw new Error(`Something else is using port ${port}. Pick another with --port.`);
  if (state === "running") {
    console.log(`  Cortex Council is already running at ${url}`);
    if (opts.open) openBrowser(url);
    return;
  }

  const child = await startServer(home, url, port, opts.detach);
  if (opts.open) openBrowser(url);
  if (opts.detach) return console.log(`  Running in the background at ${url} · stop it with: cortex-council stop`);
  // Foreground: pass Ctrl+C on (the server adjourns cleanly) and exit with it.
  for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) process.on(sig, () => child.kill(sig));
  await new Promise((r) => child.on("exit", (code) => r((process.exitCode = code ?? 0))));
}
