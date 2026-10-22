// Runs the API server and the Vite dev server together; Ctrl+C stops both.
import { spawn } from "node:child_process";

const procs = [
  spawn("npm", ["run", "dev:server"], { stdio: "inherit", shell: process.platform === "win32" }),
  spawn("npm", ["run", "dev:web"], { stdio: "inherit", shell: process.platform === "win32" }),
];
const stop = () => procs.forEach((p) => p.kill("SIGINT"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => { if (code) { stop(); process.exitCode = code; } }));
