import type { Ballot, ConsensusResult, ProposalTally } from "../../shared/types.ts";

/** Max possible stdev of scores on a 1..10 scale (half at 1, half at 10). */
const MAX_STDEV = 4.5;
/** A winner must clear this mean score, not merely beat weaker rivals. */
export const MIN_WINNING_MEAN = 6;

export function tally(proposalId: string, ballots: Ballot[]): ProposalTally {
  // Self-votes are ignored: a proposal's id is its author's member id.
  const scores = ballots
    .filter((b) => b.voter !== proposalId)
    .map((b) => b.scores[proposalId]?.score)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  if (scores.length === 0) return { proposalId, mean: 0, agreement: 0, votes: 0 };
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, s) => a + (s - mean) ** 2, 0) / scores.length;
  const agreement = Math.max(0, 1 - Math.sqrt(variance) / MAX_STDEV);
  return { proposalId, mean: round2(mean), agreement: round2(agreement), votes: scores.length };
}

export function computeConsensus(
  ballots: Ballot[],
  proposalIds: string[],
  round: number,
  threshold: number,
): ConsensusResult {
  const tallies = proposalIds
    .map((id) => tally(id, ballots))
    .sort((a, b) => b.mean - a.mean || b.agreement - a.agreement || a.proposalId.localeCompare(b.proposalId));
  const top = tallies.find((t) => t.votes > 0) ?? null;
  const blockingObjections = [...new Set(ballots.flatMap((b) => b.objections.map((o) => `${b.voter}: ${o}`)))];
  const agreement = top?.agreement ?? 0;
  const reached = Boolean(top) && agreement >= threshold && (top?.mean ?? 0) >= MIN_WINNING_MEAN && blockingObjections.length === 0;
  return { round, tallies, winner: top?.proposalId ?? null, agreement, reached, blockingObjections };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
