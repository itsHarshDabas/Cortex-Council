import { describe, expect, it } from "vitest";
import { CommandNotAllowedError, runProcess } from "../src/server/execution/runner.ts";

describe("runProcess", () => {
  it("refuses commands that are not allowlisted", async () => {
    await expect(runProcess("rm", ["-rf", "/tmp/x"], { timeoutMs: 1000, allowedCommands: ["git"] })).rejects.toBeInstanceOf(CommandNotAllowedError);
  });

  it("passes arguments verbatim, without shell interpretation", async () => {
    const evil = "$(echo pwned); `whoami` && echo injected";
    const r = await runProcess("node", ["-e", "process.stdout.write(process.argv[1])", evil], {
      timeoutMs: 10_000,
      allowedCommands: ["node"],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(evil);
  });

  it("kills processes that exceed the timeout", async () => {
    const r = await runProcess("node", ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200, allowedCommands: ["node"] });
    expect(r.timedOut).toBe(true);
  });
});
