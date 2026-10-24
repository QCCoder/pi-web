// Phase-4 Task 2: 服务端验证命令执行器（spec 2026-10-24-phase-four §7）。
//
//   runConfiguredCheck —— 在候选 checkout（prepareVerifyCheckouts 产物）内
//     同步执行人配置的验证命令（`.pi/delivery.yaml` verification.checks——
//     agent 只能触发不能自造），产出 CheckEvidence。**LLM 自述不构成证据**：
//     exitCode / outcome / logRef 只能来自这里（Task 3 的 recordCheckResult
//     累积、Task 4 的 delivery_run_check 服务端调用）。
//
//   执行契约：spawnSync 经 `/bin/sh`（command 是整条 shell 命令）、
//     cwd = 候选 worktree、timeout 默认 600s（`timeout_seconds` 1–3600 由
//     config.ts 校验）、env 继承宿主、maxBuffer 1MB（超限子进程被杀 →
//     error ENOBUFS → unverified——执行不完整的结果不可作证据）。
//
//   outcome：exit 0 → passed；非 0 → failed；spawn error（ETIMEDOUT/ENOENT/
//     ENOBUFS）→ unverified + exitCode null。注意经 shell 执行时「命令不存在」
//     是 sh 的普通退出码 127（failed）而非 ENOENT——ENOENT 只有 shell 本身
//     无法 spawn 才出现（deps 注入单测覆盖该分支）。
//
//   日志：stdout/stderr 各取尾部 32KiB（两流独立截断，合计 ≤64KiB）分节合并
//     写 `<logDir>/<safeCheckName(name)>.log`（父目录 mkdir -p + tmp+rename
//     原子写——attempts.ts writeAtomicSync 同习语）。logRef = 相对工作项根的
//     POSIX 路径：按 item.yaml 标记向上定位工作项根（spec §7 布局
//     `<item>/delivery/artifacts/verification-logs/<attemptId>/`），定位不到
//     时回落文件名。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createUlid } from "../../workspaces/id.ts";
import type { DeliveryCheckConfig } from "./config.ts";

/** 服务端产出的单条检查证据（Task 3 累积进 claim.checkResults，submit 整体取用）。 */
export interface CheckEvidence {
  name: string;
  exitCode: number | null;
  durationMs: number;
  /** 相对工作项根的 POSIX 日志路径（如 delivery/artifacts/verification-logs/<attemptId>/<safe>.log）。 */
  logRef: string;
  outcome: "passed" | "failed" | "unverified";
}

/** deps 注入缝（默认真实现；测试注入 + 真命令用例双轨）。 */
export interface RunCheckDeps {
  spawnSync?: typeof spawnSync;
  now?: () => number;
}

const TAIL_BYTES_PER_STREAM = 32 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 600;
const SPAWN_MAX_BUFFER = 1024 * 1024;
const ITEM_MARKER = "item.yaml";
const ITEM_ROOT_SEARCH_DEPTH = 8;

/** 文件名安全化：非 [\w.-] → _（防路径注入——name 是人写的配置，落到 <logDir>/ 下必须是单文件名）。 */
export function safeCheckName(name: string): string {
  return name.replace(/[^\w.-]/g, "_");
}

/** 单流尾部 32KiB。字节级截断可能切开多字节 UTF-8 首字符——日志场景接受（替换符）。 */
function tailText(stream: Buffer | null | undefined): string {
  if (!stream || stream.length === 0) return "";
  const tail = stream.length > TAIL_BYTES_PER_STREAM
    ? stream.subarray(stream.length - TAIL_BYTES_PER_STREAM)
    : stream;
  return tail.toString("utf8");
}

/** 分节正文：剥掉至多一个收尾换行（echo 类命令自带 \n + 分节分隔 \n 会双空行；
 *  不改变非换行收尾的内容——尾部 32KiB 的末字节原样保留）。 */
function logSection(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** service.ts writeAtomic 的同步镜像（attempts.ts 同习语；本模块是同步签名）。 */
function writeLogAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${createUlid()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/** 从 logDir 向上找 item.yaml（工作项根标记）；找不到 → undefined。 */
function findItemRoot(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (let depth = 0; depth < ITEM_ROOT_SEARCH_DEPTH; depth += 1) {
    if (existsSync(join(current, ITEM_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** 相对工作项根的 POSIX 路径；无工作项根（logDir 不在 item 下）→ 回落文件名。 */
function logRefFor(logPath: string): string {
  const itemRoot = findItemRoot(dirname(logPath));
  if (itemRoot !== undefined) {
    const rel = relative(itemRoot, logPath);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      return sep === "/" ? rel : rel.split(sep).join("/");
    }
  }
  return basename(logPath);
}

/**
 * 执行一条配置的验证命令并产出证据。同步（spawnSync——分钟级命令在锁外跑，
 * 本函数自身不持业务锁；Ruling 4）。无论 outcome 如何日志都落盘（unverified
 * 的现场同样要审计）。
 */
export function runConfiguredCheck(
  check: DeliveryCheckConfig,
  worktreePath: string,
  logDir: string,
  deps: RunCheckDeps = {},
): CheckEvidence {
  const spawnSyncImpl = deps.spawnSync ?? spawnSync;
  const now = deps.now ?? Date.now;

  const startedAt = now();
  const result = spawnSyncImpl(check.command, {
    cwd: worktreePath,
    shell: "/bin/sh",
    timeout: (check.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    env: process.env,
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  const durationMs = Math.max(0, now() - startedAt);

  const logPath = join(logDir, `${safeCheckName(check.name)}.log`);
  writeLogAtomic(
    logPath,
    `--- stdout ---\n${logSection(tailText(result.stdout))}`
      + `\n--- stderr ---\n${logSection(tailText(result.stderr))}\n`,
  );
  const logRef = logRefFor(logPath);

  if (result.error) {
    // ETIMEDOUT / ENOENT / ENOBUFS 等：进程没跑完（或没起来）——不构成通过或
    // 失败的判定，exitCode 置 null（真实退出码不存在）。
    return { name: check.name, exitCode: null, durationMs, logRef, outcome: "unverified" };
  }
  const exitCode = result.status;
  return {
    name: check.name,
    exitCode,
    durationMs,
    logRef,
    outcome: exitCode === 0 ? "passed" : "failed",
  };
}
