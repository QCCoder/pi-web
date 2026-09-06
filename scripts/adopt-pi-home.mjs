#!/usr/bin/env node
/**
 * adopt-pi-home.mjs — one-time migration: move the pi data home (~/.pi) INTO
 * this repo's .pi/ so workspaces, skills and sessions are visible in the
 * project tree.
 *
 *   ~/.pi/agent          →  <repo>/.pi/agent            (PI_CODING_AGENT_DIR)
 *   ~/.pi/workspaces     →  <repo>/.pi/workspaces       (PI_WORKSPACES_DIR)
 *   ~/.pi/workspace.yaml →  <repo>/.pi/workspace-index.yaml (PI_WORKSPACE_INDEX_FILE)
 *
 * Beyond the raw moves it fixes everything that embeds the OLD absolute paths:
 *   - the global index entries (absolute workspace paths)
 *   - session directory names (they encode the session cwd: "/" → "-")
 *   - .jsonl contents (parentSession / cwd / sessionFile references)
 *     — plain substring replacement is structurally safe inside JSON strings
 *       (both old and new values are plain ASCII paths).
 *   - drops the rebuildable session-index caches (.index.json)
 *
 * It then writes .env.local (the daemon self-loads it; Next loads it natively)
 * and appends a guarded `export PI_CODING_AGENT_DIR=…` block to the shell rc
 * so the terminal `pi` CLI shares the SAME home (option A: one home).
 *
 * Run from a plain terminal, with pi sessions closed. The running pi-daemon
 * is stopped automatically; restart `npm run dev` afterwards. Re-running is
 * safe (detects the adopted state and only repairs .env.local / shell rc).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oldPi = path.join(os.homedir(), ".pi");
const newPi = path.join(repoRoot, ".pi");

const OLD_AGENT = path.join(oldPi, "agent");
const NEW_AGENT = path.join(newPi, "agent");
const OLD_WS = path.join(oldPi, "workspaces");
const NEW_WS = path.join(newPi, "workspaces");
const OLD_INDEX = path.join(oldPi, "workspace.yaml");
const NEW_INDEX = path.join(newPi, "workspace-index.yaml");

// Order-independent (disjoint prefixes), but keep workspaces first for clarity.
const REPLACEMENTS = [
  [OLD_WS, NEW_WS],
  [OLD_AGENT, NEW_AGENT],
];

function applyReplacements(text) {
  let out = text;
  for (const [from, to] of REPLACEMENTS) out = out.split(from).join(to);
  return out;
}

const exists = (p) => fs.existsSync(p);
const log = (s) => process.stdout.write(`${s}\n`);

function stopDaemon() {
  const base = (process.env.PI_DAEMON_URL ?? process.env.PI_LOOP_URL ?? "http://127.0.0.1:30142").replace(/\/$/, "");
  let port;
  try {
    port = new URL(base).port || "30142";
  } catch {
    port = "30142";
  }
  let healthy = false;
  try {
    execFileSync("curl", ["-fsS", "-m", "2", `${base}/health`], { stdio: ["ignore", "ignore", "ignore"] });
    healthy = true;
  } catch {}
  if (!healthy) {
    log(`· pi-daemon 未在运行（${base} 无响应），跳过停止步骤`);
    return;
  }
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
    const pids = [...new Set(out.split("\n").map((l) => l.trim()).filter(Boolean))];
    if (pids.length === 0) {
      log(`· pi-daemon 健康但找不到 pid（port ${port}），请手动停止后重跑`);
      process.exit(1);
    }
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {}
    }
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      try {
        execFileSync("curl", ["-fsS", "-m", "1", `${base}/health`], { stdio: ["ignore", "ignore", "ignore"] });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // sleep 300ms
      } catch {
        log(`· 已停止 pi-daemon (pid ${pids.join(",")})`);
        return;
      }
    }
    log(`! pi-daemon 未能优雅退出，继续前请手动确认（lsof -ti tcp:${port}）`);
    process.exit(1);
  } catch {
    log("· 无法通过 lsof 找到 daemon，假设未运行，继续");
  }
}

function moveTree(from, to) {
  execFileSync("mv", ["-n", from, to]);
  log(`✓ mv ${from} → ${to}`);
}

/** Rewrite a small text config in place. Returns true when changed. */
function rewriteFileIfChanged(file) {
  const before = fs.readFileSync(file, "utf8");
  const after = applyReplacements(before);
  if (after === before) return false;
  fs.writeFileSync(file, after);
  return true;
}

/** Rename session dirs whose name embeds the old workspaces cwd encoding. */
function renameSessionDirs(sessionsRoot) {
  const encOldWs = OLD_WS.split("/").join("-");
  let renamed = 0;
  const renameLevel = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.includes(encOldWs)) continue;
      const from = path.join(dir, entry.name);
      const newName = entry.name.split(encOldWs).join(NEW_WS.split("/").join("-"));
      const to = path.join(dir, newName);
      if (from === to || exists(to)) continue;
      fs.renameSync(from, to);
      renamed += 1;
    }
  };
  renameLevel(sessionsRoot);
  const archived = path.join(sessionsRoot, ".archived");
  if (exists(archived)) renameLevel(archived);
  return renamed;
}

/** Rewrite every *.jsonl under the sessions tree. Returns files changed. */
function rewriteSessionFiles(sessionsRoot) {
  let changed = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (rewriteFileIfChanged(p)) changed += 1;
      }
    }
  };
  walk(sessionsRoot);
  return changed;
}

function dropIndexCaches(sessionsRoot) {
  for (const file of [
    path.join(sessionsRoot, ".index.json"),
    path.join(sessionsRoot, ".archived", ".index.json"),
  ]) {
    if (exists(file)) {
      fs.rmSync(file);
      log(`✓ 删除可重建的会话索引缓存 ${file}`);
    }
  }
}

/** Best-effort `git worktree repair` for moved workspaces: worktree `.git`
 *  pointer files embed ABSOLUTE gitdir paths that go stale after the move. */
function repairWorktrees() {
  if (!exists(NEW_WS)) return;
  let repaired = 0;
  const candidates = [];
  for (const ws of fs.readdirSync(NEW_WS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsRoot = path.join(NEW_WS, ws.name);
    candidates.push(wsRoot);
    const reposRoot = path.join(wsRoot, "repositories");
    if (exists(reposRoot)) {
      for (const kind of fs.readdirSync(reposRoot, { withFileTypes: true })) {
        if (!kind.isDirectory()) continue;
        const kindRoot = path.join(reposRoot, kind.name);
        for (const repo of fs.readdirSync(kindRoot, { withFileTypes: true })) {
          if (repo.isDirectory()) candidates.push(path.join(kindRoot, repo.name));
        }
      }
    }
  }
  for (const dir of candidates) {
    if (!exists(path.join(dir, ".git"))) continue;
    try {
      execFileSync("git", ["-C", dir, "worktree", "repair"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      repaired += 1;
    } catch {
      // not a repo / broken beyond repair — leave it, `git worktree prune` is a
      // manual follow-up the user can decide on
    }
  }
  if (repaired) log(`✓ git worktree repair 跑了 ${repaired} 个仓库（修复 worktree 绝对路径指针）`);
}

function writeEnvLocal() {
  const file = path.join(repoRoot, ".env.local");
  const block = [
    "# Written by scripts/adopt-pi-home.mjs — pi data home lives in this repo's .pi/.",
    `PI_CODING_AGENT_DIR=${NEW_AGENT}`,
    `PI_WORKSPACES_DIR=${NEW_WS}`,
    `PI_WORKSPACE_INDEX_FILE=${NEW_INDEX}`,
    "",
  ].join("\n");
  if (exists(file)) {
    const current = fs.readFileSync(file, "utf8");
    if (current.includes("PI_CODING_AGENT_DIR=")) return log("✓ .env.local 已存在且配置过，跳过");
    log(`! .env.local 已存在但不包含数据家变量，请手动追加：\n${block}`);
    return;
  }
  fs.writeFileSync(file, block);
  log(`✓ 写入 ${file}`);
}

function patchShellRc() {
  const shell = process.env.SHELL ?? "";
  const rc = shell.endsWith("zsh")
    ? path.join(os.homedir(), ".zshrc")
    : shell.endsWith("bash")
      ? path.join(os.homedir(), ".bashrc")
      : null;
  const block = [
    "# >>> pi data home (pi-web) >>>",
    `export PI_CODING_AGENT_DIR=${NEW_AGENT}`,
    "# <<< pi data home (pi-web) <<<",
    "",
  ].join("\n");
  if (!rc) {
    log(`! 未能识别 shell（$SHELL=${shell || "空"}），请手动 export：\n${block.trim()}`);
    return;
  }
  const current = exists(rc) ? fs.readFileSync(rc, "utf8") : "";
  if (current.includes("# >>> pi data home (pi-web) >>>")) return log(`✓ ${rc} 已有 pi data home 块，跳过`);
  fs.appendFileSync(rc, `\n${block}`);
  log(`✓ 追加 export PI_CODING_AGENT_DIR 到 ${rc}`);
}

// ---------------------------------------------------------------------------

log(`pi data home 迁移：${oldPi} → ${newPi}\n`);

if (!exists(path.join(repoRoot, "package.json")) || !exists(path.join(repoRoot, ".pi"))) {
  log("! 脚本位置异常（找不到 package.json / .pi），拒绝执行");
  process.exit(1);
}
if (process.env.PI_SESSION_FILE) {
  log("! 你正在一个 pi 会话里跑这个脚本：迁移后该会话的后续写入会落到旧路径重建的目录。");
  log("! 最好等会话结束后从普通终端重跑。10 秒后继续……（Ctrl-C 取消）");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
}

const alreadyMoved =
  (!exists(OLD_AGENT) || !exists(OLD_WS)) && (exists(NEW_AGENT) || exists(NEW_WS));

if (alreadyMoved) {
  log("· 数据已迁移过（源不在/目标在），进入修复模式：只补 .env.local 与 shell rc");
  writeEnvLocal();
  patchShellRc();
  log("\n完成。重启 npm run dev 即可。");
  process.exit(0);
}

for (const [from, to] of [
  [OLD_AGENT, NEW_AGENT],
  [OLD_WS, NEW_WS],
  [OLD_INDEX, NEW_INDEX],
]) {
  if (exists(to)) {
    log(`! 目标已存在：${to}（源 ${from} 也存在？）请先处理再重跑`);
    process.exit(1);
  }
}

const leftoverTemplates = path.join(oldPi, "workspace-templates");
if (exists(leftoverTemplates)) {
  log(`! 注意：${leftoverTemplates} 存在，但仓库已有 git 管理的 .pi/workspace-templates，不搬迁、原地保留`);
}

// Same-volume note (mv falls back to copy across volumes — fine, just slower).
try {
  const a = fs.statfsSync(oldPi).dev;
  const b = fs.statfsSync(repoRoot).dev;
  if (a !== b) log("! 源与目标不在同一卷：mv 将退化为完整拷贝（19G 可能需要几分钟）");
} catch {}

log("\n[1/5] 停止 pi-daemon …");
stopDaemon();

log("\n[2/5] 移动数据 …");
fs.mkdirSync(newPi, { recursive: true });
if (exists(OLD_AGENT)) moveTree(OLD_AGENT, NEW_AGENT);
if (exists(OLD_WS)) moveTree(OLD_WS, NEW_WS);
if (exists(OLD_INDEX)) moveTree(OLD_INDEX, NEW_INDEX);

log("\n[3/5] 修正绝对路径引用 …");
if (exists(NEW_INDEX) && rewriteFileIfChanged(NEW_INDEX)) log("✓ 改写 workspace-index.yaml 中的工作区路径");
const sessionsRoot = path.join(NEW_AGENT, "sessions");
if (exists(sessionsRoot)) {
  const renamed = renameSessionDirs(sessionsRoot);
  if (renamed) log(`✓ 重命名 ${renamed} 个会话目录（编码了旧 workspaces cwd）`);
  const rewritten = rewriteSessionFiles(sessionsRoot);
  if (rewritten) log(`✓ 改写 ${rewritten} 个 .jsonl 内的路径引用`);
  dropIndexCaches(sessionsRoot);
}
for (const cfg of [
  path.join(NEW_AGENT, "settings.json"),
  path.join(NEW_AGENT, "models.json"),
]) {
  if (exists(cfg) && rewriteFileIfChanged(cfg)) log(`✓ 改写 ${path.basename(cfg)}`);
}
const skillsRoot = path.join(NEW_AGENT, "skills");
if (exists(skillsRoot)) {
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md") && rewriteFileIfChanged(p)) n += 1;
    }
  };
  walk(skillsRoot);
  if (n) log(`✓ 改写 skills 下 ${n} 个 .md 的路径引用`);
}
repairWorktrees();

log("\n[4/5] 写入 .env.local …");
writeEnvLocal();

log("\n[5/5] 配置终端 shell（方案 A：CLI 与 pi-web 共用同一个家）…");
patchShellRc();

log(`
完成 ✅  接下来：
  1. 重启 dev server：Ctrl-C 后重新 npm run dev（旧进程还持有旧路径的环境变量）
  2. 开一个新终端（或 source ~/.zshrc），跑 pi 确认模型 auth / 会话历史都在
  3. 打开 pi-web 工作台，确认工作区列表正常；项目树里现在能看到 .pi/workspaces
  4. 观察几天没问题后，可手动清理 ~/.pi 残留（如 workspace-templates）
`);
