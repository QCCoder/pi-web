/** Evolution thresholds (design §7.4 / §7.5 L3). Pure constants so the rules are
 *  auditable in one place and the aggregate tests assert against them. All values
 *  implement the ASYMMETRIC principle: the core only ever auto-TIGHTENS (demote a
 *  tier, auto-add a sensitive module); relaxing (re-promote, remove sensitive)
 *  always needs a human. */

/** Minimum high-confidence samples before a module's accuracy can demote its
 *  tier. Below this, accuracy is "null" (too few to judge) — never demote. */
export const MIN_SAMPLES = 3;

/** High-confidence accuracy floor. A module with accuracy below this (and
 *  >= MIN_SAMPLES samples) is demoted: future "high" predictions count as "med",
 *  which trips gate1 in the triple judgment. */
export const ACCURACY_FLOOR = 0.7;

/** Consecutive strikes (changes_requested + rejected) at which a module is
 *  auto-added to the sensitive list. Removing it later needs a human. */
export const STRIKE_THRESHOLD = 3;

/** Outcome categories used by the strike / accuracy math. */
export const SUCCESS_OUTCOMES = new Set(["merged"]);
export const STRIKE_OUTCOMES = new Set(["changes_requested", "rejected"]);
