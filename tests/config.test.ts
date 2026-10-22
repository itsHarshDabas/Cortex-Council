import { describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, validateConfig } from "../src/server/config.ts";

describe("config validation", () => {
  it("accepts the default config", () => {
    expect(() => validateConfig(defaultConfig())).not.toThrow();
  });

  it("rejects duplicate member ids", () => {
    const c = defaultConfig();
    c.members[1]!.id = c.members[0]!.id;
    expect(() => validateConfig(c)).toThrow(ConfigError);
  });

  it("rejects CLI members whose command is not allowlisted", () => {
    const c = defaultConfig();
    c.members[0]!.adapter = { type: "cli", command: "bash", args: ["-c", "{prompt}"] };
    expect(() => validateConfig(c)).toThrow(/allowedCommands/);
  });

  it("rejects committees that reference unknown members", () => {
    const c = defaultConfig();
    c.committees[0]!.members.push("ghost");
    expect(() => validateConfig(c)).toThrow(/ghost/);
  });
});
