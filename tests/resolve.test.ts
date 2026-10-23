import { describe, expect, it } from "vitest";
import { findOnPath, resolveCommand, UnsupportedShimError } from "../src/server/execution/resolve.ts";
import { commandName } from "../src/server/execution/runner.ts";

const NPM = "C:\\Users\\harsh\\AppData\\Roaming\\npm";
const NODE = "C:\\Program Files\\nodejs\\node.exe";

// Real shim bodies as written by npm's cmd-shim, pnpm and npm itself.
const cmdShim = (target: string) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r
`;
const nativeShim = (target: string) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
"%dp0%\\${target}"   %*\r
`;
const pnpmShim = `@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=C:\\pnpm\\global\\5\\node_modules"
)
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\cline\\bin\\cline" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\global\\5\\node_modules\\cline\\bin\\cline" %*
)
`;
const npmCmd = `:: Created by npm, please don't edit manually.
@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)
SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"
)
IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (
  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"
)
"%NODE_EXE%" "%NPM_CLI_JS%" %*
`;

function fakeWindows(files: Record<string, string>, PATH = `C:\\Windows\\system32;${NPM};C:\\pnpm`) {
  const lower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    platform: "win32" as const,
    env: { Path: PATH, PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS" },
    isFile: (p: string) => lower.has(p.toLowerCase()),
    readText: (p: string) => lower.get(p.toLowerCase())!,
    nodePath: NODE,
  };
}

describe("Windows command resolution", () => {
  it("unwraps npm cmd-shims into node + script, so no shell is needed", () => {
    const win = fakeWindows({
      [`${NPM}\\opencode.cmd`]: cmdShim("node_modules\\opencode-ai\\bin\\opencode"),
      [`${NPM}\\opencode`]: "#!/bin/sh\n",
      [`${NPM}\\kilo.cmd`]: cmdShim("node_modules\\@kilocode\\cli\\bin\\kilo"),
    });
    expect(findOnPath("opencode", win)).toBe(`${NPM}\\opencode.cmd`); // the extensionless sh script is skipped
    expect(resolveCommand("opencode", win)).toEqual({ file: NODE, prefix: [`${NPM}\\node_modules\\opencode-ai\\bin\\opencode`] });
    expect(resolveCommand("kilo", win)).toEqual({ file: NODE, prefix: [`${NPM}\\node_modules\\@kilocode\\cli\\bin\\kilo`] });
  });

  it("runs a shim's native .exe directly", () => {
    const exe = `${NPM}\\node_modules\\opencode-windows-x64\\bin\\opencode.exe`;
    const win = fakeWindows({ [`${NPM}\\opencode.cmd`]: nativeShim("node_modules\\opencode-windows-x64\\bin\\opencode.exe"), [exe]: "" });
    expect(resolveCommand("opencode", win)).toEqual({ file: exe, prefix: [] });
  });

  it("handles pnpm and npm.cmd shims", () => {
    const win = fakeWindows({ "C:\\pnpm\\cline.CMD": pnpmShim, [`${NPM}\\npm.cmd`]: npmCmd });
    expect(resolveCommand("cline", win)).toEqual({ file: NODE, prefix: ["C:\\pnpm\\global\\5\\node_modules\\cline\\bin\\cline"] });
    expect(resolveCommand("npm", win)).toEqual({ file: NODE, prefix: [`${NPM}\\node_modules\\npm\\bin\\npm-cli.js`] });
  });

  it("prefers a real .exe and accepts an explicit path", () => {
    const win = fakeWindows({ "C:\\Windows\\system32\\git.exe": "", [`${NPM}\\git.cmd`]: cmdShim("x") });
    expect(resolveCommand("git", win)).toEqual({ file: "C:\\Windows\\system32\\git.exe", prefix: [] });
    const p = fakeWindows({ "D:\\tools\\cline.cmd": pnpmShim });
    expect(resolveCommand("D:\\tools\\cline.cmd", p).file).toBe(NODE);
  });

  it("refuses a batch file it cannot unwrap instead of falling back to a shell", () => {
    const win = fakeWindows({ [`${NPM}\\weird.cmd`]: "@echo off\r\ncall something.bat\r\n" });
    expect(() => resolveCommand("weird", win)).toThrow(UnsupportedShimError);
  });

  it("leaves missing commands and non-Windows platforms alone", () => {
    expect(resolveCommand("opencode", fakeWindows({}))).toEqual({ file: "opencode", prefix: [] });
    expect(resolveCommand("opencode", { platform: "linux" })).toEqual({ file: "opencode", prefix: [] });
  });

  it("matches the allowlist by name, ignoring Windows extensions and paths", () => {
    expect(commandName("C:\\Users\\harsh\\AppData\\Roaming\\npm\\kilo.cmd")).toBe("kilo");
    expect(commandName("/usr/local/bin/opencode")).toBe("opencode");
    expect(commandName("cline.EXE")).toBe("cline");
  });
});
