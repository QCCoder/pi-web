#!/usr/bin/env node
/** 一次性迁移：把 pi 托管的 workspace-c（cxin）拆解搬入外部路径工作区
 *  /Users/qiancheng/Documents/Workspace/cxin-workspace，随后 workspace-c 整体退役。
 *
 *  - 内容按映射表搬迁（机制文件进 .pi/，内容留根 —— 2026-09 一套布局约定）
 *  - 新 manifest 落 cxin-workspace/.pi/workspace.yaml：沿用原 workspace id（UI 持久化
 *    键不变），repositories 改路径登记制（path 指向孪生仓/搬迁仓的根级相对路径）
 *  - 会话历史：encoded 目录名 + .jsonl 内 cwd/parentSession 路径按映射改写
 *    （adopt-pi-home.mjs 同款语义）
 *  - 全局索引：条目 path 换成新根（id 不变）
 *
 *  默认 dry-run（只打印计划）；--apply 真正执行。重复执行安全：已存在的目标跳过。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadEnvLocal } from "../bin/load-env-local.js";

const APPLY = process.argv.includes("--apply");
const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
loadEnvLocal(REPO_ROOT);
const WS_C = join(REPO_ROOT, ".pi", "workspaces", "workspace-c");
const CXIN = "/Users/qiancheng/Documents/Workspace/cxin";
const SESSIONS_ROOT = process.env.PI_CODING_AGENT_DIR
  ? join(process.env.PI_CODING_AGENT_DIR, "sessions")
  : join(homedir(), ".pi", "agent", "sessions");
const INDEX_FILE = process.env.PI_WORKSPACE_INDEX_FILE
  ?? join(REPO_ROOT, ".pi", "workspace-index.yaml");

if (!existsSync(WS_C)) {
  console.error(`[merge] workspace-c 不存在：${WS_C}`);
  process.exit(1);
}
if (!existsSync(CXIN)) {
  console.error(`[merge] 目标工作区不存在：${CXIN}`);
  process.exit(1);
}

const move = (src, dst, label) => {
  if (!existsSync(src)) return console.log(`  跳过（源不存在）：${label}`);
  if (existsSync(dst)) return console.log(`  跳过（目标已存在）：${label}`);
  console.log(`  ${label}: ${src} → ${dst}`);
  if (!APPLY) return;
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(src, dst);
};

// ---- 会话路径映射（长前缀优先）------------------------------------------
const PATH_MAP = [
  [join(WS_C, "repositories", "cargoware-h5"), join(CXIN, "cargoware-h5-haichuang")],
  [join(WS_C, "repositories", "cargoware"), join(CXIN, "cargoware-haichuang")],
  [join(WS_C, "repositories", "cargo-h5-mp"), join(CXIN, "cargo-h5-mp")],
  [join(WS_C, "repositories", "cargoapi"), join(CXIN, "cargoapi")],
  [join(WS_C, "repositories", "cargo-report-server-haichuang"), join(CXIN, "cargo-report-server-haichuang")],
  [WS_C, CXIN],
];

/** encoded 目录名："--" + 各路径段以 "-" 相连 + "--"（实测 .index 目录名规律）。 */
const encodeDir = (path) => "--" + path.split("/").filter(Boolean).join("-") + "--";

/** 仓库别名映射（长别名优先，避免 cargoware 吃掉 cargoware-h5 的前缀）。 */
const REPO_ALIAS_MAP = [
  ["cargo-report-server-haichuang", "cargo-report-server-haichuang"],
  ["cargoware-h5", "cargoware-h5-haichuang"],
  ["cargo-h5-mp", "cargo-h5-mp"],
  ["cargoware", "cargoware-haichuang"],
  ["cargoapi", "cargoapi"],
];

function rewriteSessionDirNames() {
  console.log("—— 会话 encoded 目录改名 ——");
  if (!existsSync(SESSIONS_ROOT)) return console.log("  跳过（无会话目录）");
  const oldPrefix = encodeDir(WS_C).slice(2, -2); // "Users-...-workspace-c"
  const newPrefix = encodeDir(CXIN).slice(2, -2); // "Users-...-Workspace-cxin-workspace"
  for (const entry of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!(name.startsWith("--") && name.endsWith("--"))) continue;
    const segments = name.slice(2, -2);
    if (segments !== oldPrefix && !segments.startsWith(oldPrefix + "-")) continue;
    // ① 换工作区前缀；② 仓别名映射（encoded 段无法可靠切分路径，按
    //    "-repositories-<alias>-" 全串替换，trailing "--" 场景自然覆盖）。
    let newName = "--" + segments.replace(oldPrefix, newPrefix) + "--";
    for (const [fromAlias, toAlias] of REPO_ALIAS_MAP) {
      newName = newName.split(`-repositories-${fromAlias}-`).join(`-${toAlias}-`);
    }
    const src = join(SESSIONS_ROOT, name);
    const dst = join(SESSIONS_ROOT, newName);
    if (src === dst) continue;
    if (existsSync(dst)) {
      // 目标已存在：把源里的文件并入（会话文件名含 id，碰撞概率≈0）
      console.log(`  合并（目标已存在）: ${name} → ${newName}`);
      if (!APPLY) continue;
      for (const file of readdirSync(src)) {
        try { renameSync(join(src, file), join(dst, file)); } catch (e) { console.error(`    ${file}: ${e.message}`); }
      }
      try { rmSync(src, { recursive: true }); } catch { /* 非空即留 */ }
      continue;
    }
    console.log(`  ${name} → ${newName}`);
    if (!APPLY) continue;
    renameSync(src, dst);
  }
}

function rewriteSessionContents() {
  console.log("—— 会话 .jsonl 内 cwd/parentSession 路径改写 ——");
  if (!existsSync(SESSIONS_ROOT)) return;
  let touched = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".jsonl")) continue;
      const raw = readFileSync(full, "utf8");
      if (!raw.includes(WS_C)) continue;
      let next = raw;
      for (const [from, to] of PATH_MAP) next = next.split(from).join(to);
      if (next !== raw) {
        touched += 1;
        if (APPLY) writeFileSync(full, next);
      }
    }
  };
  walk(SESSIONS_ROOT);
  console.log(`  改写文件数：${touched}`);
}

// ---- 主流程 --------------------------------------------------------------
function moveContent() {
  console.log("—— 机制文件 → .pi/ ——");
  move(join(WS_C, "requirements"), join(CXIN, ".pi", "work-items", "requirements"), "requirements");
  move(join(WS_C, "bugs"), join(CXIN, ".pi", "work-items", "bugs"), "bugs");
  move(join(WS_C, "designs"), join(CXIN, ".pi", "work-items", "designs"), "designs");
  move(join(WS_C, "plans"), join(CXIN, ".pi", "work-items", "plans"), "plans");
  move(join(WS_C, "loops"), join(CXIN, ".pi", "loops"), "loops");
  move(join(WS_C, ".agents", "skills"), join(CXIN, ".pi", "skills"), ".agents/skills");
  move(join(WS_C, ".pi", "agents"), join(CXIN, ".pi", "agents"), ".pi/agents（subagent 角色）");
  move(join(WS_C, "LEARN"), join(CXIN, ".pi", "loops", "dev-loop", "LEARN"), "LEARN（轮执行档案）");
  move(join(WS_C, ".chandao.json"), join(CXIN, ".pi", "chandao.json"), ".chandao.json（凭据）");

  console.log("—— 内容 → 工作区根 ——");
  move(join(WS_C, "repositories", "cargoapi"), join(CXIN, "cargoapi"), "仓 cargoapi（独有）");
  move(join(WS_C, "repositories", "cargo-report-server-haichuang"), join(CXIN, "cargo-report-server-haichuang"), "仓 cargo-report-server-haichuang（独有）");
  move(join(WS_C, "knowledge", "cargo-knowledge"), join(CXIN, "cargo-knowledge"), "知识库 cargo-knowledge");
  move(join(WS_C, "docs"), join(CXIN, "docs", "workspace-c"), "docs（并入 docs/workspace-c）");
  move(join(WS_C, "软件著作权申请资料"), join(CXIN, "软件著作权申请资料"), "软件著作权申请资料");
  move(join(WS_C, "scripts"), join(CXIN, "scripts"), "scripts（chandao-sync 等）");
  // 3 份重复 clone（cargoware/cargoware-h5/cargo-h5-mp）不搬：孪生仓已在 cxin-workspace 根下，
  // 且 2 条未推分支已先行保入孪生仓 —— 这三份目录随 workspace-c 一起退役。
}

const REPO_REGISTRY = [
  { id: "01KYRBDPJ85NES2QV9DR9CBY1X", alias: "cargoware", name: "cargoware", kind: "code", path: "cargoware-haichuang" },
  { id: "01KYRBFR48HXBTD17E7KVCDX59", alias: "cargoware-h5", name: "cargoware-h5", kind: "code", path: "cargoware-h5-haichuang" },
  { id: "01KYSCJATCC52F60TBSHJ8DJT7", alias: "cargo-h5-mp", name: "cargo-h5-mp", kind: "code", path: "cargo-h5-mp" },
  { id: "01KYTXS5EWAQSPNPHZ7V2TGMAR", alias: "cargoapi", name: "cargoapi", kind: "code", path: "cargoapi" },
  { id: "01KZAR7MW5MGASV1SMHRMPM10E", alias: "cargo-report-server-haichuang", name: "cargo-report-server-haichuang", kind: "code", path: "cargo-report-server-haichuang" },
  { id: "01KYRE4837ES3DP7C75VR9WJ7B", alias: "cargo-knowledge", name: "cargo-knowledge", kind: "knowledge", path: "cargo-knowledge" },
  // 用户自建的业务知识库（独立 git 仓，register 语义 —— 只登记不改动）
  { id: "01M2Z4RFG9K7QB3C0V5XJ8WN2T", alias: "cxin-knowledge", name: "cxin-knowledge", kind: "knowledge", path: "cxin-knowledge" },
];

function writeManifest() {
  const oldManifestPath = join(WS_C, ".pi", "workspace.yaml");
  const old = parseYaml(readFileSync(oldManifestPath, "utf8"));
  const manifest = {
    schema_version: 1,
    id: old.id, // 沿用 id —— UI 的 per-workspace 持久化键（pi-active-view 等）原样保留
    slug: "cxin",
    name: old.name ?? "cxin",
    skills: old.skills ?? [],
    repositories: REPO_REGISTRY.map((repo) => ({
      id: repo.id, alias: repo.alias, name: repo.name, kind: repo.kind, path: repo.path, status: "active",
    })),
    agent: old.agent ?? {},
    capabilities: (old.capabilities ?? []).filter((c) => c !== "overview" && c !== "loop" && c !== "requirement-sources"),
    ...(old.git ? { git: old.git } : {}),
    work_items: old.work_items,
    created_at: old.created_at,
    updated_at: new Date().toISOString(),
  };
  const dst = join(CXIN, ".pi", "workspace.yaml");
  console.log(`—— manifest → ${dst} ——`);
  if (APPLY) {
    mkdirSync(dirname(dst), { recursive: true });
    if (!existsSync(dst)) writeFileSync(dst, stringifyYaml(manifest, { lineWidth: 0 }));
    else console.log("  目标已存在，跳过（保留现状）");
  }
  return manifest;
}

function updateIndex() {
  console.log("—— 全局索引换路径（id 不变） ——");
  const index = parseYaml(readFileSync(INDEX_FILE, "utf8"));
  const entry = index.workspaces.find((w) => w.id === "01KYRBBY917PW4X0VHMY5GC8TE");
  if (!entry) return console.log("  未找到 workspace-c 条目，跳过");
  if (entry.path === CXIN) return console.log("  已是新路径，跳过");
  console.log(`  ${entry.path} → ${CXIN}`);
  if (APPLY) {
    entry.path = CXIN;
    entry.last_opened_at = new Date().toISOString();
    writeFileSync(INDEX_FILE, stringifyYaml(index, { lineWidth: 0 }));
  }
}

/** cxin-workspace 根仓的 .gitignore（git init 由切换步骤执行；本函数只准备文件）。 */
function writeGitignore() {
  const dst = join(CXIN, ".gitignore");
  const content = `# pi-web 会话外的本地产物
.DS_Store
.idea/
outputs/
.worktrees/

# 项目仓各自管 git，根仓只跟踪工作区约定与 pi 机制数据
/cargo-h5-mp/
/cargoware-haichuang/
/cargoware-h5-haichuang/
/workflow_engine_v2/
/cargoapi/
/cargo-report-server-haichuang/
/cargo-knowledge/
/cxin-knowledge/

# pi 机制数据里的可重建缓存
/.pi/cache/
/.pi/*.sqlite
/.pi/*.log
`;
  console.log(`—— .gitignore → ${dst} ——`);
  if (APPLY && !existsSync(dst)) writeFileSync(dst, content);
}

// ---- 执行 ----------------------------------------------------------------
console.log(APPLY ? "=== merge-workspace-c：APPLY ===" : "=== merge-workspace-c：DRY-RUN（加 --apply 落地） ===");
moveContent();
const manifest = writeManifest();
console.log(`  仓库登记：${manifest.repositories.map((r) => `${r.alias}@${r.path}`).join(", ")}`);
writeGitignore();
rewriteSessionDirNames();
rewriteSessionContents();
updateIndex();
console.log(APPLY ? "=== 完成。workspace-c 源目录保留，验证后手动删除 ===" : "=== dry-run 结束 ===");
