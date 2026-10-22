import { describe, expect, it } from "vitest";
import type { Ballot } from "../src/shared/types.ts";
import { computeConsensus, tally } from "../src/server/orchestrator/consensus.ts";

const ballot = (voter: string, scores: Record<string, number>, objections: string[] = []): Ballot => ({
  voter,
  round: 1,
  scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { score: v, reason: "" }])),
  objections,
});

describe("consensus", () => {
  it("ignores self-votes", () => {
    const t = tally("a", [ballot("a", { a: 10 }), ballot("b", { a: 4 }), ballot("c", { a: 6 })]);
    expect(t.votes).toBe(2);
    expect(t.mean).toBe(5);
  });

  it("reaches consensus when voters agree on a strong winner", () => {
    const r = computeConsensus(
      [ballot("a", { b: 9, c: 5 }), ballot("b", { c: 5 }), ballot("c", { b: 9 }), ballot("d", { b: 8, c: 4 })],
      ["b", "c"],
      1,
      0.75,
    );
    expect(r.winner).toBe("b");
    expect(r.reached).toBe(true);
    expect(r.agreement).toBeGreaterThan(0.75);
  });

  it("does not reach consensus when scores are polarised", () => {
    const r = computeConsensus([ballot("a", { b: 10 }), ballot("c", { b: 1 }), ballot("d", { b: 10 }), ballot("e", { b: 1 })], ["b"], 1, 0.75);
    expect(r.reached).toBe(false);
    expect(r.agreement).toBeLessThan(0.1);
  });

  it("objections block consensus and are reported", () => {
    const r = computeConsensus([ballot("a", { b: 9 }), ballot("c", { b: 9 }, ["no rollback plan"])], ["b"], 1, 0.5);
    expect(r.reached).toBe(false);
    expect(r.blockingObjections).toEqual(["c: no rollback plan"]);
  });

  it("a weak but unanimous winner is not consensus", () => {
    const r = computeConsensus([ballot("a", { b: 3 }), ballot("c", { b: 3 })], ["b"], 1, 0.5);
    expect(r.agreement).toBe(1);
    expect(r.reached).toBe(false);
  });
});
