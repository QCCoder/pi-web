#!/usr/bin/env node
/** 上游漂移检查：落后 upstream/main 超过阈值即失败，防止在旧基线上继续开发。
 *  移植自 zcode 的 check-workspace-freshness 思路（fork 落后越多，下次同步越接近重写）。
 *
 *  - 阈值：PI_WEB_MAX_UPSTREAM_DRIFT（默认 50 个提交）
 *  - 跳过：PI_WEB_SKIP_UPSTREAM_CHECK=1
 *  - 上游 remote 名：PI_WEB_UPSTREAM_REMOTE（默认 "upstream"）
 *  - 离线 / 未配置 upstream 时仅警告不拦截（fail-open）：开发机断网不该挡住 npm run dev。
 *  判定逻辑拆成 evaluateDrift 纯函数，测试见同目录 .test.mjs。 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FETCH_TIMEOUT_MS = 20_000;
const UPSTREAM_URL_HINT = "git@github.com:agegr/pi-web.git";

/** 落后 N 个提交时的处置判定。输入不可信（git 输出可能缺失或异常）时降级为警告。 */
export function evaluateDrift({ behind, threshold }) {
  if (!Number.isInteger(behind) || behind < 0 || !Number.isInteger(threshold) || threshold < 0) {
    return { ok: true, severity: "warn", reason: "unknown_drift", behind: null };
  }
  if (behind > threshold) {
    return { ok: false, severity: "error", reason: "over_threshold", behind };
  }
  return { ok: true, severity: "info", reason: "within_threshold", behind };
}

/** 阈值解析：非法输入一律回退默认 50，而不是报错——检查器自己不能成为开发的障碍。 */
export function resolveThreshold(raw, fallback = 50) {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", timeout: FETCH_TIMEOUT_MS }).trim();
  } catch {
    return null;
  }
}

function main() {
  if (process.env.PI_WEB_SKIP_UPSTREAM_CHECK === "1") {
    console.log("[pi-web] 已按 PI_WEB_SKIP_UPSTREAM_CHECK=1 跳过上游漂移检查。");
    return 0;
  }
  const remote = process.env.PI_WEB_UPSTREAM_REMOTE || "upstream";
  const threshold = resolveThreshold(process.env.PI_WEB_MAX_UPSTREAM_DRIFT);

  const remotes = git(["remote"]);
  if (remotes === null || !remotes.split("\n").includes(remote)) {
    console.warn(`[pi-web] 未配置 git remote "${remote}"，跳过漂移检查。如需启用：git remote add ${remote} ${UPSTREAM_URL_HINT}`);
    return 0;
  }
  if (git(["fetch", remote, "main", "--quiet"]) === null) {
    console.warn("[pi-web] 无法访问 upstream（离线或网络受限），本次跳过漂移检查。");
    return 0;
  }

  const behindRaw = git(["rev-list", "--count", `HEAD..${remote}/main`]);
  const behind = behindRaw === null ? null : Number.parseInt(behindRaw, 10);
  const verdict = evaluateDrift({ behind, threshold });

  if (verdict.severity === "error") {
    console.error(`[pi-web] ✗ 落后 ${remote}/main 已达 ${verdict.behind} 个提交（阈值 ${threshold}）。`);
    console.error("  在旧基线上继续开发会让下一次上游同步更痛苦，请先处理漂移：");
    console.error(`    1. git log --oneline HEAD..${remote}/main | head -30    # 看看落后了什么`);
    console.error("    2. 参考 docs/ 下的 upstream 审计文档与 AGENTS.md 的移植流程合并/移植");
    console.error(`    3. 确需跳过本次检查：PI_WEB_SKIP_UPSTREAM_CHECK=1；或调高阈值：PI_WEB_MAX_UPSTREAM_DRIFT=<n>`);
    return 1;
  }
  if (verdict.severity === "warn") {
    console.warn("[pi-web] 无法确定与上游的分叉数，跳过漂移检查。");
    return 0;
  }
  console.log(`[pi-web] 上游漂移检查通过：落后 ${remote}/main ${verdict.behind} 个提交（阈值 ${threshold}）。`);
  return 0;
}

// 仅直接执行时才真正跑检查：测试文件 import 本模块拿纯函数，不应触发 git fetch 或 exitCode。
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
