/**
 * Model routing. Default Haiku 4.5 for mechanical decisions, escalate to
 * Sonnet 4.6 for semantic / cryptographic reasoning, reserve Opus 4.7 for
 * family identification and multi-stage strategy decisions.
 *
 * Cost control: every decision emits a usage record. The session caps total
 * spend and degrades to Haiku-only if the budget runs low.
 */

export type ModelTier = "haiku" | "sonnet" | "opus";

export const MODEL_IDS = {
  haiku:  "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus:   "claude-opus-4-7",
} as const;

/** Approximate pricing in USD per million tokens, as of 2026-04. */
export const PRICING_USD_PER_MTOK = {
  haiku:  { input: 1.00,  output: 5.00  },
  sonnet: { input: 3.00,  output: 15.00 },
  opus:   { input: 5.00,  output: 25.00 },
} as const;

export interface ModelRouteHint {
  /** Pythia may set this in an inner thought to request escalation. */
  needsEscalation?: boolean;
  /** True when the trigger reason involves crypto, unpacking, or family ID. */
  triggerSuggestsHardProblem?: boolean;
  /** Pause count — if we've been paused here many times, Haiku is getting stuck. */
  pauseCount?: number;
}

export function chooseModel(hint: ModelRouteHint): ModelTier {
  if (hint.needsEscalation) {
    // If we've already escalated once and still stuck, go to Opus.
    return (hint.pauseCount ?? 0) > 5 ? "opus" : "sonnet";
  }
  if (hint.triggerSuggestsHardProblem) {
    return "sonnet";
  }
  return "haiku";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: ModelTier;
}

export function usageCostUsd(u: TokenUsage): number {
  const p = PRICING_USD_PER_MTOK[u.model];
  return (u.inputTokens * p.input + u.outputTokens * p.output) / 1_000_000;
}
