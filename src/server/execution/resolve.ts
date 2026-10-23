import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Windows-safe command resolution.
 *
 * npm, pnpm and yarn install CLIs on Windows as `.cmd` batch shims (opencode.cmd, cline.cmd, kilo.cmd,
 * claude.cmd, npm.cmd). `spawn` without a shell cannot find them, and Node refuses to run batch files
 * without `shell: true` (CVE-2024-27980). Going through cmd.exe would re-parse model output as shell
 * syntax and cannot carry newlines in arguments at all, so instead we read the shim and run what it
 * runs: `node <script>` or the native `.exe` it points at. No shell is ever involved.
 */

export interface ResolveEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; default to the real filesystem. */
  isFile?: (p: string) => boolean;
  readText?: (p: string) => string;
  nodePath?: string;
}

export interface Resolved {
  file: string;
  /** argv entries to put before the caller's arguments (e.g. the shim's script). */
  prefix: string[];
}

export class UnsupportedShimError extends Error {}

const defaultIsFile = (win: boolean) => (p: string) => {
  try {
    if (!statSync(p).isFile()) return false;
    if (!win) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Finds an executable on PATH without spawning it. On Windows, tries each PATHEXT extension. */
export function findOnPath(command: string, opts: ResolveEnv = {}): string | undefined {
  const platform = opts.platform ?? process.platform;
  const win = platform === "win32";
  const env = opts.env ?? process.env;
  const path = win ? win32 : posix;
  const isFile = opts.isFile ?? defaultIsFile(win);
  const pathVar = win ? (env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1]) : env.PATH;
  const dirs = path.isAbsolute(command) || command.includes(path.sep) ? [""] : (pathVar ?? "").split(path.delimiter).filter(Boolean);
  let exts = [""];
  if (win) {
    const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase());
    // A name that already has an executable extension is tried as-is first.
    exts = pathext.includes(path.extname(command).toLowerCase()) ? ["", ...pathext] : pathext;
  }
  for (const d of dirs)
    for (const ext of exts) {
      const p = d ? path.join(d.replace(/^"|"$/g, ""), command + ext) : command + ext;
      if (isFile(p)) return p;
    }
  return undefined;
}

/**
 * What to actually spawn for `command`. Outside Windows this is the command itself (spawn searches
 * PATH). On Windows, `.exe`/`.com` run directly and `.cmd`/`.bat` shims are unwrapped.
 * A command that cannot be found is returned unchanged so spawn reports ENOENT as usual.
 */
export function resolveCommand(command: string, opts: ResolveEnv = {}): Resolved {
  if ((opts.platform ?? process.platform) !== "win32") return { file: command, prefix: [] };
  const found = findOnPath(command, opts);
  if (!found) return { file: command, prefix: [] };
  const ext = win32.extname(found).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { file: found, prefix: [] };
  const text = (opts.readText ?? ((p) => readFileSync(p, "utf8")))(found);
  const target = parseShim(text, win32.dirname(found), opts.nodePath ?? process.execPath, opts.isFile ?? defaultIsFile(true));
  if (!target)
    throw new UnsupportedShimError(
      `"${found}" is a batch file Cortex cannot run without a shell. Set adapter.command to the tool's .exe (or its node script) instead.`,
    );
  return target;
}

/**
 * Reads an npm (cmd-shim), pnpm or npm.cmd-style shim and returns the program it launches.
 * Handles `%~dp0` / `%dp0%` and simple `SET "NAME=value"` variables (e.g. `_prog`, `NODE_EXE`).
 */
export function parseShim(text: string, shimDir: string, nodePath: string, isFile: (p: string) => boolean): Resolved | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const vars: Record<string, string> = {};
  const dir = shimDir.replace(/[\\/]+$/, "") + "\\";
  const expand = (s: string) => {
    let out = s.replace(/%~dp0%?|%dp0%/gi, dir);
    for (let i = 0; i < 3; i++) out = out.replace(/%([A-Za-z_][\w]*)%/g, (m, n: string) => vars[n.toUpperCase()] ?? m);
    return out;
  };
  for (const l of lines) {
    const m = /^@?SET\s+"?([A-Za-z_]\w*)=([^"]*)"?\s*$/i.exec(l);
    if (!m || m[1]!.toUpperCase() === "PATHEXT") continue;
    // Keep only values we can fully resolve; skip FOR-loop (`%%F`) and runtime-derived ones.
    const value = expand(m[2]!);
    if (!value.includes("%")) vars[m[1]!.toUpperCase()] = value;
  }
  // The launch line is the last one forwarding the arguments (`%*`); keep what follows the last `&`.
  const line = [...lines].reverse().find((l) => /(^|\s)%\*\s*$/.test(l));
  if (!line) return undefined;
  const call = line.slice(line.lastIndexOf("&") + 1);
  const tokens = [...call.matchAll(/"([^"]*)"|(\S+)/g)].map((t) => t[1] ?? t[2]!).filter((t) => t !== "%*" && !t.startsWith("@"));
  if (!tokens.length) return undefined;
  const first = win32.normalize(expand(tokens[0]!));
  if (/(^|[\\/])node(\.exe)?$/i.test(first)) {
    if (tokens.length < 2) return undefined;
    return { file: nodePath, prefix: [win32.normalize(expand(tokens[1]!)), ...tokens.slice(2).map(expand)] };
  }
  if (/\.(exe|com)$/i.test(first) && isFile(first)) return { file: first, prefix: tokens.slice(1).map(expand) };
  return undefined;
}
