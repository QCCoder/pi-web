// One-off: backfill titles for historical dev-loop orchestrator sessions.
//
// Problem: every dev-loop orchestrator session is seeded with the same generic
// bootstrap prompt, so they all share an identical title. After the runtime
// fix (lib/loop/pi-execution.ts sessionNamer), NEW runs get `（Loop）<title>`.
// This script retroactively renames the historical ones that already ran and
// linked themselves to a work item.
//
// A session is renamed iff ALL of:
//   1. its id appears in some work item's `conversations` array, AND
//   2. its first user message is the dev-loop bootstrap prompt (so we never
//      touch a normal chat session that happens to be linked to a work item), AND
//   3. it has no session_info entry yet (don't clobber a user/manual name).
//
// Usage:
//   node --import tsx scripts/backfill-loop-session-names.mjs            # dry-run
//   node --import tsx scripts/backfill-loop-session-names.mjs --apply     # write
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const APPLY = process.argv.includes("--apply");
const WORKSPACE = process.env.PI_BACKFILL_WS || "/Users/qiancheng/.pi/workspaces/workspace-c";
const AGENT_DIR = process.env.PI_AGENT_DIR || `${process.env.HOME}/.pi/agent`;
const BOOTSTRAP = "你是这一 generic Loop 的常驻 orchestrator 会话";
const LOOP_PREFIX_NEW = "(Loop) ";
const LOOP_PREFIX_OLD = "（Loop）"; // pre-fixup full-width form, migrated on rerun

// --- 1. collect sessionId -> work item {key,title} from requirements/bugs ---
async function collectLinked() {
  const map = new Map(); // sessionId -> { key, title }
  for (const dir of ["requirements", "bugs"]) {
    const root = join(WORKSPACE, dir);
    let entries = [];
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let item;
      try { item = parse(await readFile(join(root, e.name, "item.yaml"), "utf8")); } catch { continue; }
      const conv = Array.isArray(item.conversations) ? item.conversations : [];
      for (const sid of conv) if (typeof sid === "string") map.set(sid, { key: item.key, title: item.title });
    }
  }
  return map;
}

// --- 2. locate a session file by its id (filename ends with <uuid>.jsonl) ---
// Locate a session file by its id. Searches every encoded-cwd directory AND any
// `.archived/` subdirectory beneath it (archive-cascade moves finished work-item
// conversations there). Filename ends with `_<uuid>.jsonl`.
async function findSessionFile(sessionId) {
  const sessionsDir = join(AGENT_DIR, "sessions");
  let topDirs = [];
  try { topDirs = await readdir(sessionsDir, { withFileTypes: true }); } catch { return undefined; }
  for (const d of topDirs) {
    if (!d.isDirectory()) continue;
    const dirPath = join(sessionsDir, d.name);
    let files = [];
    try { files = await readdir(dirPath, { withFileTypes: true }); } catch { continue; }
    for (const entry of files) {
      let candidate;
      if (entry.isFile() && entry.name.endsWith(`_${sessionId}.jsonl`)) candidate = entry.name;
      else if (entry.isDirectory() && entry.name === ".archived") {
        let sub = [];
        try { sub = await readdir(join(dirPath, ".archived")); } catch { continue; }
        const hit = sub.find((f) => f.endsWith(`_${sessionId}.jsonl`));
        if (hit) return join(dirPath, ".archived", hit);
        continue;
      }
      if (candidate) return join(dirPath, candidate);
    }
  }
  return undefined;
}

// --- 3. classify a session file ---
async function classify(filePath) {
  let firstUserText = null;
  let hasName = false;
  let name = null;
  let firstLineCwd = null;
  const rl = (await readFile(filePath, "utf8")).split("\n");
  for (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session" && entry.cwd) firstLineCwd = entry.cwd;
    if (entry.type === "session_info") { hasName = true; name = entry.name ?? null; }
    if (firstUserText === null && entry.type === "message" && entry.message?.role === "user") {
      const c = entry.message.content;
      firstUserText = typeof c === "string" ? c : JSON.stringify(c ?? "");
    }
  }
  return { firstUserText, hasName, name, cwd: firstLineCwd };
}

// Decide an action for one loop session. We re-normalize our OWN old-format
// auto-name (`（Loop）` full-width) to the current `(Loop) ` form, but never
// touch a name we didn't generate (manual rename / other source).
function decideAction(info) {
  if (!info.hasName) return "rename";
  const name = typeof info.name === "string" ? info.name : "";
  if (name.startsWith(LOOP_PREFIX_NEW)) return "skip";     // already current
  if (name.startsWith(LOOP_PREFIX_OLD)) return "rename";   // migrate our old form
  return "skip";                                            // someone else's name — don't clobber
}

const linked = await collectLinked();
console.log(`linked sessions from work items: ${linked.size}`);

const plan = [];
for (const [sid, item] of linked) {
  const file = await findSessionFile(sid);
  if (!file) { plan.push({ sid, status: "no-file", item }); continue; }
  const info = await classify(file);
  const isLoop = info.firstUserText?.includes(BOOTSTRAP);
  const proposed = `${LOOP_PREFIX_NEW}${item.title}`;
  const action = !isLoop ? "skip-not-loop" : decideAction(info);
  plan.push({ sid, status: action, key: item.key, title: item.title, proposed, file, ...info, isLoop });
}

// --- report ---
const groups = {};
for (const p of plan) (groups[p.status] ??= []).push(p);
for (const [status, rows] of Object.entries(groups)) {
  console.log(`\n=== ${status} (${rows.length}) ===`);
  for (const r of rows) {
    if (r.status === "rename") {
      console.log(`  ${r.key}  ${r.sid}\n    -> ${r.proposed}`);
    } else if (r.status === "skip") {
      console.log(`  ${r.key ?? r.item?.key}  ${r.sid}  (kept existing name: ${JSON.stringify(r.name)})`);
    } else if (r.status === "skip-not-loop") {
      console.log(`  ${r.key ?? r.item?.key}  ${r.sid}  (first msg not loop bootstrap)`);
    } else {
      console.log(`  ${r.sid}`);
    }
  }
}

if (!APPLY) {
  console.log(`\n[dry-run] ${groups.rename?.length ?? 0} session(s) would be renamed. Re-run with --apply to write.`);
  process.exit(0);
}

// --- apply ---
let done = 0;
for (const r of plan) {
  if (r.status !== "rename") continue;
  try {
    const sm = SessionManager.open(r.file, undefined);
    sm.appendSessionInfo(r.proposed);
    console.log(`  renamed ${r.key}  ${r.sid}  -> ${r.proposed}`);
    done++;
  } catch (err) {
    console.error(`  FAILED ${r.sid}:`, err);
  }
}
console.log(`\n[apply] renamed ${done} session(s).`);
