/** STATE.md derived-block management (design §7.4b / §7.5 L3). The derived block
 *  (calibration + auto-sensitive) is RECOMPUTABLE, so it lives between managed
 *  markers and is safe to overwrite. `mergeStateFile` is idempotent and pure;
 *  the LearnScheduler calls it after aggregate().
 *
 *  Mirrors the workspace AGENTS.md managed-segment pattern (replace between
 *  markers; insert if absent) — but for the dev Loop's own STATE.md. STATE.md
 *  lives in git, so a bad evolution is revertable (§7.5 insurance). */

import type { DerivedState, ModuleStats } from "./types.ts";

export const DERIVED_START = "<!-- dev-loop:derived:start -->";
export const DERIVED_END = "<!-- dev-loop:derived:end -->";

function fmtPct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(0)}%`;
}

function renderModuleRow(m: ModuleStats): string {
  const parts = [
    `- ${m.module}: samples=${m.samples}`,
    `high=${fmtPct(m.highConfAccuracy)} (${m.highConfSamples})`,
    `tier=${m.effectiveHighTier}`,
    `strikes=${m.strikes}`,
    `stuck=${fmtPct(m.stuckRate)}`,
  ];
  return parts.join(" | ");
}

/** Render the derived block (content placed between the markers). */
export function renderDerivedBlock(derived: DerivedState): string {
  const lines: string[] = [];
  lines.push("## Derived (auto — do not hand-edit; recomputed from LEARN.jsonl)");
  lines.push("");
  lines.push("```");
  if (derived.modules.length === 0) {
    lines.push("# module_calibration: <no samples yet>");
  } else {
    lines.push("# module_calibration:");
    for (const m of derived.modules) lines.push(renderModuleRow(m));
  }
  if (derived.sensitiveAuto.length === 0) {
    lines.push("# sensitive_auto: <none>");
  } else {
    lines.push("# sensitive_auto:");
    for (const s of derived.sensitiveAuto) {
      lines.push(`- ${s.module}: strikes=${s.strikes} added=${s.addedAt} — ${s.reason}`);
    }
  }
  lines.push(`# computed_at: ${derived.computedAt}`);
  lines.push("```");
  return lines.join("\n");
}

/** Wrap the derived block with the managed markers. */
export function renderDerivedSection(derived: DerivedState): string {
  return `${DERIVED_START}\n${renderDerivedBlock(derived)}\n${DERIVED_END}`;
}

const MARKER_RE = new RegExp(
  `${escapeRe(DERIVED_START)}[\\s\\S]*?${escapeRe(DERIVED_END)}`,
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Merge a fresh derived block into a STATE.md string. If the markers exist, the
 *  content between them is replaced (idempotent recompute); otherwise the block
 *  is appended. Pure — returns the new file content. */
export function mergeStateFile(stateMd: string, derived: DerivedState): string {
  const section = renderDerivedSection(derived);
  if (MARKER_RE.test(stateMd)) {
    return stateMd.replace(MARKER_RE, section);
  }
  const sep = stateMd.endsWith("\n") ? "" : "\n";
  return `${stateMd}${sep}\n${section}\n`;
}
