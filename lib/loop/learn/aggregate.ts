/** The evolution CORE — a pure function from LEARN records to derived calibration
 *  / sensitive state (design §7.4). This is deep-module seam #3: all the
 *  statistics (accuracy, strikes, stuck-rate, tier demotion, auto-sensitive) live
 *  behind `aggregate()`. The orchestrator NEVER does this math (design §7.4 core
 *  A: "never trust an LLM to count").
 *
 *  Pure: given the records it returns a fresh `DerivedState`; the caller (Learn
 *  Scheduler) writes it into STATE.md's managed block. Re-running on the same
 *  records is idempotent. Asymmetric by construction (§7.5 L3): it only demotes
 *  tiers and auto-adds sensitive modules — it never promotes or removes. */

import {
  ACCURACY_FLOOR,
  MIN_SAMPLES,
  STRIKE_OUTCOMES,
  STRIKE_THRESHOLD,
  SUCCESS_OUTCOMES,
} from "./config.ts";
import type {
  DerivedState,
  LearnRecord,
  ModuleStats,
  SensitiveAutoEntry,
} from "./types.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Parse a LEARN.jsonl blob into validated records. Malformed lines are skipped
 *  (an append-only log stays usable after a partial final line). */
export function parseLearnRecords(content: string): LearnRecord[] {
  const out: LearnRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = coerceLearnRecord(value);
    if (record) out.push(record);
  }
  return out;
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

function coerceLearnRecord(value: unknown): LearnRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (!isString(r.runId) || !isString(r.module) || !isString(r.repo) || !isString(r.workItemKey)) return null;
  if (!isString(r.ts)) return null;
  if (!oneOf(r.predictedConf, ["high", "med", "low"] as const)) return null;
  if (!oneOf(r.outcome, ["merged", "changes_requested", "rejected", "blocked"] as const)) return null;
  if (!oneOf(r.riskTier, ["sensitive", "normal"] as const)) return null;
  if (!oneOf(r.tests, ["green", "red", "none"] as const)) return null;
  return {
    runId: r.runId,
    workItemKey: r.workItemKey,
    module: r.module,
    repo: r.repo,
    predictedConf: r.predictedConf,
    outcome: r.outcome,
    riskTier: r.riskTier,
    tests: r.tests,
    ...(isString(r.humanDecision) ? { humanDecision: r.humanDecision } : {}),
    ts: r.ts,
  };
}

interface ModuleAccumulator {
  module: string;
  records: LearnRecord[]; // time-ordered (append order)
}

/** Recompute the full derived state from the raw feedback dataset. */
export function aggregate(records: readonly LearnRecord[], now: string = new Date().toISOString()): DerivedState {
  const byModule = new Map<string, ModuleAccumulator>();
  for (const record of records) {
    let acc = byModule.get(record.module);
    if (!acc) {
      acc = { module: record.module, records: [] };
      byModule.set(record.module, acc);
    }
    acc.records.push(record);
  }

  const modules: ModuleStats[] = [];
  const sensitiveAuto: SensitiveAutoEntry[] = [];
  for (const { module, records: mods } of byModule.values()) {
    const samples = mods.length;
    const high = mods.filter((r) => r.predictedConf === "high");
    const judged = high.filter((r) => r.outcome !== "blocked");
    const highMerged = judged.filter((r) => SUCCESS_OUTCOMES.has(r.outcome)).length;
    const highConfSamples = judged.length;
    const highConfAccuracy = highConfSamples >= MIN_SAMPLES ? highMerged / highConfSamples : null;
    const effectiveHighTier: "high" | "med" =
      highConfAccuracy !== null && highConfAccuracy < ACCURACY_FLOOR ? "med" : "high";

    // Tail strikes: walk in time order; +1 for changes_requested/rejected, reset on merged.
    let strikes = 0;
    for (const r of mods) {
      if (STRIKE_OUTCOMES.has(r.outcome)) strikes += 1;
      else if (SUCCESS_OUTCOMES.has(r.outcome)) strikes = 0;
      // blocked: leave the streak unchanged
    }
    const blocked = mods.filter((r) => r.outcome === "blocked").length;
    const stuckRate = samples > 0 ? blocked / samples : 0;

    modules.push({
      module,
      samples,
      highConfSamples,
      highConfAccuracy,
      effectiveHighTier,
      strikes,
      stuckRate,
    });

    if (strikes >= STRIKE_THRESHOLD) {
      // The crossing record is the one that brought the tail to the threshold.
      const crossing = [...mods].reverse().find((r) => STRIKE_OUTCOMES.has(r.outcome));
      sensitiveAuto.push({
        module,
        strikes,
        addedAt: crossing?.ts ?? mods[mods.length - 1].ts,
        reason: `${strikes} consecutive strikes (changes_requested/rejected); auto-added per §7.5 L3`,
      });
    }
  }

  modules.sort((a, b) => a.module.localeCompare(b.module));
  sensitiveAuto.sort((a, b) => a.module.localeCompare(b.module));
  return { computedAt: now, modules, sensitiveAuto };
}

/** The calibration lookup the orchestrator's DECIDE step uses: given a module and
 *  the agent's self-rated confidence, return the *effective* confidence after the
 *  calibration table correction. Only ever demotes high -> med (asymmetric). */
export function effectiveTier(
  module: string,
  predictedConf: "high" | "med" | "low",
  derived: DerivedState,
): "high" | "med" | "low" {
  if (predictedConf !== "high") return predictedConf;
  const stats = derived.modules.find((m) => m.module === module);
  if (stats && stats.effectiveHighTier === "med") return "med";
  return "high";
}

/** Is a module currently auto-sensitive (per the derived state)? */
export function isAutoSensitive(module: string, derived: DerivedState): boolean {
  return derived.sensitiveAuto.some((e) => e.module === module);
}

export type { Mutable };
