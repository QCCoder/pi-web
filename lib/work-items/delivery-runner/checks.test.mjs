// Phase-4 Task 2: checks.ts——服务端验证命令执行器。
// 真命令（/bin/sh）驱动默认实现：
//   1. exit 0 → passed，logRef = 相对工作项根（item.yaml 标记）的 POSIX 路径，
//      日志落盘带 stdout/stderr 分节
//   2. exit 1（带 stdout+stderr）→ failed，双流都进日志
//   3. 超时（sleep 5 + timeout_seconds:1）→ unverified + exitCode null，
//      日志仍写、耗时 ~1s
//   4. 不存在的命令（真 /bin/sh 语义）→ exitCode 127 → failed（不是 ENOENT
//      ——ENOENT 只有 shell 本身无法 spawn 才出现，经 deps 注入单测）
//   5. 注入 spawnSync 返回 error(ENOENT/ETIMEDOUT) → unverified + exitCode null
//   6. 执行契约（注入捕获）：shell /bin/sh、cwd=worktree、timeout=
//      timeout_seconds ?? 600（秒→ms）、env=process.env、maxBuffer 1MB
//   7. 大输出：stdout/stderr 各取尾部 32KiB（头部丢弃、尾部保留），双流独立
//   8. safeCheckName：非 [\w.-] → _（路径注入安全），文件落在 <logDir>/<safe>.log
//   9. now 注入 → durationMs 精确；logDir 不在工作项下 → logRef 回落文件名
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const STDOUT_MARK = "--- stdout ---";
const STDERR_MARK = "--- stderr ---";
const TAIL = 32 * 1024;

/** 工作项形状的日志环境：<root>/item/{item.yaml} + logDir = spec §7 布局。 */
async function makeCheckEnv(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-checks-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const worktree = join(root, "wt");
  await mkdir(worktree, { recursive: true });
  const itemRoot = join(root, "item");
  await mkdir(itemRoot, { recursive: true });
  await writeFile(join(itemRoot, "item.yaml"), "key: REQ-0001\n", "utf8");
  const logDir = join(itemRoot, "delivery", "artifacts", "verification-logs", "att-1");
  return { root, worktree, itemRoot, logDir };
}

/** 日志正文 → { stdout, stderr } 分节内容（剥标记与换行边界）。 */
function splitLog(content) {
  const stdoutStart = content.indexOf(STDOUT_MARK);
  const stderrStart = content.indexOf(STDERR_MARK);
  assert.ok(stdoutStart !== -1 && stderrStart !== -1, `log has both markers:\n${content.slice(0, 200)}`);
  const stdout = content.slice(stdoutStart + STDOUT_MARK.length + 1, stderrStart - 1);
  const stderr = content.slice(stderrStart + STDERR_MARK.length + 1).replace(/\n$/, "");
  return { stdout, stderr };
}

// --------------------------------------------------------------- outcomes

test("runConfiguredCheck exit 0 → passed with item-relative POSIX logRef and the log on disk", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const { worktree, logDir } = await makeCheckEnv(t);

  const evidence = runConfiguredCheck({ name: "unit", command: "exit 0" }, worktree, logDir);
  assert.deepEqual(
    { ...evidence, durationMs: 0 },
    { name: "unit", exitCode: 0, durationMs: 0, logRef: "delivery/artifacts/verification-logs/att-1/unit.log", outcome: "passed" },
  );
  assert.ok(evidence.durationMs >= 0);
  const logPath = join(logDir, "unit.log");
  assert.ok(existsSync(logPath), "log written (logDir mkdir -p'd)");
  const { stdout, stderr } = splitLog(readFileSync(logPath, "utf8"));
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("runConfiguredCheck exit 1 with both streams → failed; stdout and stderr land in their log sections", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const { worktree, logDir } = await makeCheckEnv(t);

  const evidence = runConfiguredCheck(
    { name: "lint", command: "echo out-line; echo err-line 1>&2; exit 1" },
    worktree, logDir,
  );
  assert.equal(evidence.outcome, "failed");
  assert.equal(evidence.exitCode, 1);
  const { stdout, stderr } = splitLog(readFileSync(join(logDir, "lint.log"), "utf8"));
  assert.equal(stdout, "out-line");
  assert.equal(stderr, "err-line");
});

test("runConfiguredCheck timeout → unverified with exitCode null; log still written; duration bounded by the timeout", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const { worktree, logDir } = await makeCheckEnv(t);

  const evidence = runConfiguredCheck(
    { name: "slow", command: "sleep 5", timeout_seconds: 1 },
    worktree, logDir,
  );
  assert.equal(evidence.outcome, "unverified");
  assert.equal(evidence.exitCode, null);
  assert.ok(evidence.durationMs >= 900, `duration >= 900ms (got ${evidence.durationMs})`);
  assert.ok(evidence.durationMs < 5_000, `killed at the 1s timeout, not the full sleep (got ${evidence.durationMs})`);
  assert.ok(existsSync(join(logDir, "slow.log")), "unverified runs still write their log");
});

test("runConfiguredCheck missing command (real /bin/sh) → exitCode 127 → failed, stderr carries sh's reason", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const { worktree, logDir } = await makeCheckEnv(t);

  const evidence = runConfiguredCheck(
    { name: "gone", command: "pi-no-such-command-xyz-12345" },
    worktree, logDir,
  );
  // shell 路径下「命令不存在」是 sh 的普通退出码 127（failed），不是 ENOENT。
  assert.equal(evidence.outcome, "failed");
  assert.equal(evidence.exitCode, 127);
  const { stderr } = splitLog(readFileSync(join(logDir, "gone.log"), "utf8"));
  assert.match(stderr, /not found/);
});

test("runConfiguredCheck spawn error (ENOENT injected) → unverified with exitCode null", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const { worktree, logDir } = await makeCheckEnv(t);

  const injected = () => ({
    error: Object.assign(new Error("spawn pi-no-such ENOENT"), { code: "ENOENT" }),
    status: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  const evidence = runConfiguredCheck({ name: "enoent", command: "anything" }, worktree, logDir, {
    spawnSync: injected,
  });
  assert.equal(evidence.outcome, "unverified");
  assert.equal(evidence.exitCode, null);
  assert.ok(existsSync(join(logDir, "enoent.log")));
});

test("runConfiguredCheck spawn error (ETIMEDOUT injected) → unverified with exitCode null", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const { worktree, logDir } = await makeCheckEnv(t);

  const injected = () => ({
    error: Object.assign(new Error("spawn ETIMEDOUT"), { code: "ETIMEDOUT" }),
    status: null,
    signal: "SIGTERM",
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  const evidence = runConfiguredCheck({ name: "tm", command: "x" }, worktree, logDir, {
    spawnSync: injected,
  });
  assert.equal(evidence.outcome, "unverified");
  assert.equal(evidence.exitCode, null);
});

// ---------------------------------------------------------- exec contract

test("runConfiguredCheck exec contract: shell /bin/sh, cwd=worktree, timeout seconds→ms (default 600), env inherited, maxBuffer 1MB", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const { worktree, logDir } = await makeCheckEnv(t);

  const seen = [];
  const injected = (command, options) => {
    seen.push({ command, options });
    return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };

  runConfiguredCheck({ name: "a", command: "make check" }, worktree, logDir, { spawnSync: injected });
  runConfiguredCheck({ name: "b", command: "make check", timeout_seconds: 2 }, worktree, logDir, { spawnSync: injected });

  assert.equal(seen.length, 2);
  const [first, second] = seen;
  assert.equal(first.command, "make check");
  assert.equal(first.options.shell, "/bin/sh");
  assert.equal(first.options.cwd, worktree);
  assert.equal(first.options.timeout, 600_000, "default 600s in ms");
  assert.equal(first.options.env, process.env, "env passed through by reference");
  assert.equal(first.options.maxBuffer, 1024 * 1024);
  assert.equal(second.options.timeout, 2_000, "timeout_seconds honoured");
});

// ------------------------------------------------------------ truncation

test("runConfiguredCheck large output: each stream keeps its tail 32KiB (head dropped), streams truncated independently", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const { worktree, logDir } = await makeCheckEnv(t);

  // stdout = 199990B of "a\n" + 14B marker（=200004B > 32KiB）；stderr = 100000B "b\n"。
  const evidence = runConfiguredCheck(
    {
      name: "big",
      command: '(yes a | head -c 199990; printf "TAIL_MARKER_9z"; yes b | head -c 100000 1>&2)',
    },
    worktree, logDir,
  );
  assert.equal(evidence.outcome, "passed", "head exits 0 — the pipe's last status");
  const { stdout, stderr } = splitLog(readFileSync(join(logDir, "big.log"), "utf8"));
  // stdout 尾部 = 32768B = 32754B 的 "a\n"（16377 对）+ 14B marker。
  assert.equal(Buffer.byteLength(stdout), TAIL, "stdout section is exactly the 32KiB tail");
  assert.ok(stdout.endsWith("TAIL_MARKER_9z"), "tail marker (the END of the stream) survives");
  assert.equal(stdout.match(/a/g).length, 16377, "head of the stream dropped, tail kept");
  // stderr 独立截断到自己的 32KiB 尾部（100000B → 16384 个 "b\n" 对）；收尾换行
  // 被分节正文归一剥掉 → 32767B，但 16384 个 b 一个不少。
  assert.equal(Buffer.byteLength(stderr), TAIL - 1, "stderr section is its own 32KiB tail (minus the normalized trailing newline)");
  assert.equal(stderr.match(/b/g).length, 16384);
});

// ------------------------------------------------------------ safeCheckName

test("safeCheckName keeps [\\w.-] and replaces everything else with _ (path-injection safe)", async () => {
  const { safeCheckName } = await import("./checks.ts");
  assert.equal(safeCheckName("unit.v2-x"), "unit.v2-x");
  assert.equal(safeCheckName("build & test!"), "build___test_");
  assert.equal(safeCheckName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(safeCheckName("构建检查"), "____");
});

test("runConfiguredCheck with a hostile name writes inside logDir only", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const { root, worktree, logDir } = await makeCheckEnv(t);

  const evidence = runConfiguredCheck({ name: "../../evil", command: "exit 0" }, worktree, logDir);
  assert.equal(evidence.logRef, "delivery/artifacts/verification-logs/att-1/.._.._evil.log");
  assert.ok(existsSync(join(logDir, ".._.._evil.log")), "log lands at the sanitized name");
  assert.ok(!existsSync(join(root, "evil.log")), "no escape above logDir");
});

// --------------------------------------------------------- now / fallback

test("runConfiguredCheck durationMs comes from the injected now", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const { worktree, logDir } = await makeCheckEnv(t);

  let tick = 0;
  const injected = () => ({ status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  const evidence = runConfiguredCheck({ name: "clock", command: "true" }, worktree, logDir, {
    spawnSync: injected,
    now: () => { tick += 1; return tick === 1 ? 1_000 : 3_500; },
  });
  assert.equal(evidence.durationMs, 2_500);
});

test("runConfiguredCheck logRef falls back to the file name when logDir is not under a work item", async (t) => {
  const { runConfiguredCheck } = await import("./checks.ts");
  const root = await mkdtemp(join(tmpdir(), "pi-checks-plain-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const worktree = join(root, "wt");
  await mkdir(worktree, { recursive: true });
  const logDir = join(root, "plain-logs");

  const evidence = runConfiguredCheck({ name: "free", command: "exit 0" }, worktree, logDir);
  assert.equal(evidence.logRef, "free.log");
  assert.ok(existsSync(join(logDir, "free.log")));
});
