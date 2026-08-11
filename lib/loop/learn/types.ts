/** Dev-loop evolution domain types (design §7.4). The evolution core is split
 *  exactly along the "computable vs judgment" line:
 *  - LEARN records (qualitative, one per round) are written by the orchestrator.
 *  - `DerivedState` (per-module accuracy / strikes / stuck-rate) is recomputed by
 *    a PURE function (aggregate.ts) — an LLM never counts (design §7.4 core A).
 *
 *  Memory is keyed by MODULE / repo, never by work item (§7.7): swapping the
 *  Importer or channel carries the accumulated understanding of cargoware intact. */

/** One feedback line in loops/dev-loop/LEARN.jsonl (append-only, never deleted).
 *  Written by the orchestrator at its learn step. Malformed lines are skipped by
 *  the parser — a torn final line never corrupts the dataset. */
export interface LearnRecord {
  runId: string;
  workItemKey: string;
  /** Module key, e.g. "finance-service" or repo alias "cargoware-h5". */
  module: string;
  repo: string;
  predictedConf: "high" | "med" | "low";
  riskTier: "sensitive" | "normal";
  outcome: "merged" | "changes_requested" | "rejected" | "blocked";
  tests: "green" | "red" | "none";
  humanDecision?: string;
  ts: string;
}

export const LEARN_OUTCOMES = ["merged", "changes_requested", "rejected", "blocked"] as const;
export const LEARN_CONFS = ["high", "med", "low"] as const;
export const LEARN_RISKS = ["sensitive", "normal"] as const;
export const LEARN_TESTS = ["green", "red", "none"] as const;

/** Per-module derived statistics (recomputed, safe to overwrite). */
export interface ModuleStats {
  module: string;
  /** Total records for this module. */
  samples: number;
  /** High-confidence records (the ones the calibration cares about). */
  highConfSamples: number;
  /** high-conf accuracy = merged / (merged + changes_requested + rejected).
   *  null when highConfSamples < MIN_SAMPLES (too few to judge). */
  highConfAccuracy: number | null;
  /** Whether high-confidence predictions for this module should be demoted to
   *  medium (accuracy below floor with enough samples). Asymmetric: only ever
   *  demotes (auto-tighten); re-promoting needs a human (design §7.5 L3). */
  effectiveHighTier: "high" | "med";
  /** Consecutive non-merged outcomes at the tail (changes_requested / rejected). */
  strikes: number;
  /** blocked / samples. */
  stuckRate: number;
}

/** A module auto-added to the sensitive list by the evolution core (asymmetric:
 *  auto-add on strike threshold; removal needs a human). */
export interface SensitiveAutoEntry {
  module: string;
  strikes: number;
  /** ts of the record that crossed the threshold. */
  addedAt: string;
  reason: string;
}

/** The full derived block, recomputed from LEARN.jsonl by aggregate(). */
export interface DerivedState {
  computedAt: string;
  modules: ModuleStats[];
  sensitiveAuto: SensitiveAutoEntry[];
}
