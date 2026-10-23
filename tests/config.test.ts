import { describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, validateConfig } from "../src/server/config.ts";
import { testConfig, validConfig } from "./helpers.ts";

describe("config validation", () => {
  it("ships with no members: a fresh install has no mock or placeholder seats", () => {
    const c = defaultConfig();
    expect(c.members).toEqual([]);
    expect(c.committees.every((x) => x.members.length === 0)).toBe(true);
    expect(() => validateConfig(c)).not.toThrow();
  });

  it("accepts a populated config", () => {
    expect(() => validateConfig(validConfig())).not.toThrow();
  });

  it("rejects the removed mock adapter type", () => {
    const c = testConfig();
    expect(() => validateConfig(c)).toThrow(/unknown adapter "mock"/);
  });

  it("rejects duplicate member ids", () => {
    const c = validConfig();
    c.members[1]!.id = c.members[0]!.id;
    expect(() => validateConfig(c)).toThrow(ConfigError);
  });

  it("rejects CLI members whose command is not allowlisted", () => {
    const c = validConfig();
    c.members[0]!.adapter = { type: "cli", command: "bash", args: ["-c", "{prompt}"] };
    expect(() => validateConfig(c)).toThrow(/allowedCommands/);
  });

  it("rejects committees that reference unknown members", () => {
    const c = validConfig();
    c.committees[0]!.members.push("ghost");
    expect(() => validateConfig(c)).toThrow(/ghost/);
  });
});
