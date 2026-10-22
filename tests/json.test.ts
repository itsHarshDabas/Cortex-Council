import { describe, expect, it } from "vitest";
import { extractJson } from "../src/server/util/json.ts";

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses fenced JSON surrounded by prose", () => {
    expect(extractJson('Sure! Here it is:\n```json\n{"a": [1, 2]}\n```\nHope that helps.')).toEqual({ a: [1, 2] });
  });
  it("finds the first balanced object, ignoring braces inside strings", () => {
    expect(extractJson('My answer: {"s": "a } tricky { string", "n": {"x": 1}} trailing')).toEqual({
      s: "a } tricky { string",
      n: { x: 1 },
    });
  });
  it("returns null when nothing parses", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
  });
});
