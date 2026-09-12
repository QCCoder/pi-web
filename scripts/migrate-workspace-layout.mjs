#!/usr/bin/env node
/** 通用布局迁移：把每个已注册工作区的散装 pi 机制目录收进 `.pi/`（2026-09 一套约定），
 *  并把 repositories/knowledge 固定布局目录搬到根级 `<alias>/`、manifest 改路径登记。
 *
 *  适用于仍住在 pi workspaces 目录下的工作区（ai-api / stock-assistant / search /
 *  简历筛选 / AI 视频工厂 / 机器人编程实战 / pi-web 自身 / .openclaw）。
 *  workspace-c → cxin-workspace 的合并不在本脚本（见 merge-workspace-c.mjs）。
 *
 *  迁移项（源存在才动，目标已存在跳过）：
 *    requirements|bugs|designs|plans   → .pi/work-items/<同名>
 *    loops/                            → .pi/loops/
 *    loop-pause-all                    → .pi/loop/pause-all
 *    loop-constraints.md               → .pi/loop/constraints.md
 *    loop-budget.md                    → .pi/loop/budget.md
 *    .agents/skills/                   → .pi/skills/（整目录换名）
 *    repositories/[kind/]<alias>/      → <alias>/（登记 path）
 *    knowledge/<alias>/                → <alias>/（登记 path）
 *    manifest.repositories[].path      → 实际落位（缺省回填）
 *    manifest.capabilities             → 剥离退役值（overview/loop/requirement-sources）
 *
 *  默认 dry-run；--apply 落地。幂等：重跑全部跳过。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadEnvLocal } from "../bin/load-env-local.js";

const APPLY = process.argv.includes("--apply");
const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
loadEnvLocal(REPO_ROOT);
const ONLY = (() => {
  const at = process.argv.indexOf("--only");
  return at >= 0 ? process.argv[at + 1] : undefined; // 按 name 过滤，便于单workspace试跑
})();
const INDEX_FILE = process.env.PI_WORKSPACE_INDEX_FILE
  ?? join(REPO_ROOT, ".pi", "workspace-index.yaml");
const RETIRED_CAPABILITIES = new Set(["overview", "loop", "requirement-sources"]);

const index = parseYaml(readFileSync(INDEX_FILE, "utf8"));

const move = (src, dst, label, indent = "  ") => {
  if (!existsSync(src)) return false;
  if (existsSync(dst)) {
    console.log(`${indent}跳过（目标已存在）：${label}`);
    return false;
  }
  console.log(`${indent}${label}: ${src} → ${dst}`);
  if (APPLY) {
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
  }
  return true;
};

for (const entry of index.workspaces ?? []) {
  const ws = entry.path;
  if (ONLY && entry.name !== ONLY) continue;
  if (ws.includes("workspace-c")) continue; // ws-c 走 merge-workspace-c.mjs
  if (!existsSync(ws)) {
    console.log(`[${entry.name}] 跳过（目录不可用）：${ws}`);
    continue;
  }
  console.log(`[${entry.name}] ${ws}`);

  // 1) 工作项 / loops / 宪法 / skills → .pi/
  move(join(ws, "requirements"), join(ws, ".pi", "work-items", "requirements"), "requirements");
  move(join(ws, "bugs"), join(ws, ".pi", "work-items", "bugs"), "bugs");
  move(join(ws, "designs"), join(ws, ".pi", "work-items", "designs"), "designs");
  move(join(ws, "plans"), join(ws, ".pi", "work-items", "plans"), "plans");
  move(join(ws, "loops"), join(ws, ".pi", "loops"), "loops");
  move(join(ws, "loop-pause-all"), join(ws, ".pi", "loop", "pause-all"), "loop-pause-all");
  move(join(ws, "loop-constraints.md"), join(ws, ".pi", "loop", "constraints.md"), "loop-constraints.md");
  move(join(ws, "loop-budget.md"), join(ws, ".pi", "loop", "budget.md"), "loop-budget.md");
  move(join(ws, ".agents", "skills"), join(ws, ".pi", "skills"), ".agents/skills");
  try {
    const leftover = join(ws, ".agents");
    if (APPLY && existsSync(leftover) && readdirSync(leftover).length === 0) {
      renameSync(leftover, `${leftover}.migrated-${Date.now()}`);
    }
  } catch { /* 尽力清理 */ }

  // 2) 仓库固定布局 → 根级 <alias>/（登记制）；候选按历史布局枚举
  let manifestRaw = null;
  const manifestPath = join(ws, ".pi", "workspace.yaml");
  try {
    manifestRaw = parseYaml(readFileSync(manifestPath, "utf8"));
  } catch {
    console.log("  跳过 manifest（不可读/缺失）");
    continue;
  }
  const repos = Array.isArray(manifestRaw.repositories) ? manifestRaw.repositories : [];
  let reposChanged = false;
  for (const repo of repos) {
    if (!repo || typeof repo !== "object") continue;
    const alias = String(repo.alias ?? "");
    if (!alias || repo.path) continue; // 已登记
    const kindDir = repo.kind === "knowledge" ? "knowledge" : "code";
    const candidates = [
      join(ws, alias),
      join(ws, "repositories", alias),
      join(ws, "repositories", kindDir, alias),
      join(ws, "knowledge", alias),
    ];
    const existing = candidates.find((p) => existsSync(p));
    const target = join(ws, alias);
    if (existing && existing !== target) {
      move(existing, target, `仓 ${alias}（${existing.slice(ws.length + 1)} → ${alias}/）`);
    }
    repo.path = alias;
    reposChanged = true;
  }

  // 3) capabilities 剥退役值 + 落盘（只在真的有变更时写）
  let changed = reposChanged;
  if (Array.isArray(manifestRaw.capabilities)) {
    const filtered = manifestRaw.capabilities.filter((c) => !RETIRED_CAPABILITIES.has(c));
    if (filtered.length !== manifestRaw.capabilities.length) {
      manifestRaw.capabilities = filtered;
      changed = true;
    }
  }
  if (changed) {
    manifestRaw.updated_at = new Date().toISOString();
    console.log(`  manifest 更新（path 登记 ×${repos.filter((r) => r?.path).length}）`);
    if (APPLY) writeFileSync(manifestPath, stringifyYaml(manifestRaw, { lineWidth: 0 }));
  }
}
console.log(APPLY ? "=== 布局迁移完成 ===" : "=== dry-run 结束（加 --apply 落地） ===");
