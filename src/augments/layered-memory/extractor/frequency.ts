import type { TrustLevel } from "../../../types";

/**
 * Per-trust-level extraction frequency knobs (Decision 3 of the memorist
 * design). Operators choose how aggressively auto-save extracts per cohort:
 *
 *   - "every-turn": extract after every completed turn
 *   - "every-N-turns": extract after turns where turnIndex % N === 0
 *   - "session-end-only": buffer transcripts; flush at session boundary
 *   - "never": skip extraction entirely for this cohort
 */
export type ExtractionFrequency = "every-turn" | "every-N-turns" | "session-end-only" | "never";

/**
 * Outcome of the frequency check for a single completed turn:
 *
 *   - "extract": run extraction now (immediate write path)
 *   - "buffer": append the transcript to the per-peer buffer (deferred)
 *   - "skip": do nothing for this turn
 */
export type ExtractionDecision = "extract" | "buffer" | "skip";

/**
 * Nested configuration shape consumed by the dispatcher. `public` splits
 * into `recognized` (visitor-token holders) and `anonymous` (no token /
 * fresh visitor) so operators can be more aggressive with returning
 * recognized visitors than with first-touch traffic.
 */
export interface ExtractionFrequencyConfig {
  creator?: ExtractionFrequency;
  agent?: ExtractionFrequency;
  public?: {
    recognized?: ExtractionFrequency;
    anonymous?: ExtractionFrequency;
  };
}

/**
 * Minimal peer descriptor used by the dispatcher. The full PeerIdentity
 * carries more fields, but only trust + public substate matter for
 * frequency selection.
 */
export interface PeerInput {
  trustLevel: TrustLevel;
  publicSubstate?: "recognized" | "anonymous";
}

/**
 * Pure dispatch: given a peer, the current turn index for that peer, and
 * the operator's frequency config, return whether to extract immediately,
 * buffer, or skip. No side effects, no I/O.
 */
export function shouldExtract(
  peer: PeerInput,
  turnIndex: number,
  config: ExtractionFrequencyConfig,
  everyNTurns: number,
): ExtractionDecision {
  const freq = resolveFrequency(peer, config);
  if (freq === "never") return "skip";
  if (freq === "every-turn") return "extract";
  if (freq === "session-end-only") return "buffer";
  if (freq === "every-N-turns") return turnIndex % everyNTurns === 0 ? "extract" : "skip";
  return "skip";
}

function resolveFrequency(peer: PeerInput, config: ExtractionFrequencyConfig): ExtractionFrequency {
  if (peer.trustLevel === "creator") return config.creator ?? "every-turn";
  if (peer.trustLevel === "agent") return config.agent ?? "every-N-turns";
  if (peer.trustLevel === "public") {
    const sub = peer.publicSubstate ?? "anonymous";
    return config.public?.[sub] ?? (sub === "recognized" ? "every-turn" : "session-end-only");
  }
  // Defensive — unknown trust levels (shouldn't happen given the union)
  // skip extraction rather than fall through to a default that might
  // accidentally write under an unintended peer cohort.
  console.warn(`[layered-memory] unknown trust level: ${peer.trustLevel}; skipping extraction`);
  return "never";
}
