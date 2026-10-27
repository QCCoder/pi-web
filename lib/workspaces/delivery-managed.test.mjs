// final-arch step-6 Task 2（2026-10-26）：AGENTS.md delivery managed 块（spec
// §13.1/§13.5.1）。机制照抄 repositories 块（updateManagedRepositoryInstructions
// 同款 anchor-replace）：有标记才改写、无标记不建、标记删了即停。真临时目录：
//   1. 渲染形状：`## Delivery automation` + enabled 状态 + 四活角色行（profile
//      存在性 + 有效模型/缺省）+ checks 一行（仓别名解析、无 repositoryId 裸名、
//      未配置）+ stages 三开关（integrate 带命令）。
//   2. 标记在场 → 标记间替换，标记外字节不动；命令里的 `$1` 等 replace 特殊串
//      原样保留（函数式替换）。
//   3. 无标记 → 文件字节不动；渲染一次后删标记再跑 → 不重建；AGENTS.md 缺失 →
//      no-op（不建文件）。
//   4. AGENTS.md 读-改-写全程持工作区写锁（final-fix I2——并发安全难以单测，
//      源断言钉住锁的使用：锁包住 readFile 到 writeAtomic 全程）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  renderDeliveryManagedBlock,
  updateManagedDeliveryInstructions,
} = await createJiti(import.meta.url).import("./delivery-managed.ts");
const { writeDeliveryRunnerConfig } = await createJiti(import.meta.url)
  .import("../work-items/delivery-runner/config.ts");

const START = "<!-- workspace-managed:delivery:start -->";
const END = "<!-- workspace-managed:delivery:end -->";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-delivery-managed-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function roleSummary(role, overrides = {}) {
  return {
    role,
    profile: { name: role, path: `/ws/.pi/agents/${role}.md`, exists: false, explicit: false, ...overrides.profile },
    model: { source: "default", ...overrides.model },
  };
}

const roles = [
  roleSummary("designer", { profile: { exists: true } }),
  roleSummary("developer", {
    profile: { name: "dev", exists: true, explicit: true },
    model: { effective: { provider: "openai", modelId: "gpt-5.1" }, source: "override" },
  }),
  roleSummary("reviewer", { model: { effective: { modelId: "glm-5" }, source: "profile" } }),
  roleSummary("release-preparer"),
];

const enabledConfig = {
  schemaVersion: 2,
  enabled: true,
  roles: {},
  budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  attention: { nudgeAfterDays: 3, parkAfterDays: 7 },
  stages: {
    review: { enabled: true },
    integrate: { enabled: true, command: "sh .pi/scripts/integrate.sh $1" },
    acceptance: { enabled: false },
  },
  verification: {
    checks: [
      { name: "ok", repositoryId: "repo-1", command: "npm test" },
      { name: "h5", repositoryId: "gone", command: "pytest" },
      { name: "lint", command: "npm run lint" },
    ],
  },
};

const aliases = new Map([["repo-1", "repo-a"]]);

test("render pins the block shape: heading, status, role lines, checks line, stages line", () => {
  const block = renderDeliveryManagedBlock(enabledConfig, roles, aliases);
  assert.ok(block.startsWith(`${START}\n## Delivery automation\n\n`), "markers included, heading first");
  assert.ok(block.endsWith(END), "block closes with the end marker");
  assert.match(block, /^- status: enabled$/m);
  assert.match(block, /^- designer: profile designer \(exists\), model default$/m);
  assert.match(block, /^- developer: profile dev \(exists\), model openai\/gpt-5\.1$/m);
  assert.match(block, /^- reviewer: profile reviewer \(missing\), model glm-5$/m);
  assert.match(block, /^- release-preparer: profile release-preparer \(missing\), model default$/m);
  // checks：别名解析命中、未登记仓回退原 id、无 repositoryId 裸名。
  assert.match(block, /^- checks: ok \(repo-a\), h5 \(gone\), lint$/m);
  // stages：integrate 带命令原样展示（含 $ 特殊字符）。
  assert.match(block, /^- stages: review on · integrate on \(sh \.pi\/scripts\/integrate\.sh \$1\) · acceptance off$/m);
});

test("render with no config or roles: disabled, default models, checks none, stages off", () => {
  const block = renderDeliveryManagedBlock(null, [], new Map());
  assert.match(block, /^- status: disabled$/m);
  assert.match(block, /^- checks: none$/m);
  assert.match(block, /^- stages: review off · integrate off · acceptance off$/m);
});

test("markers present: replaced between markers, bytes outside untouched, idempotent", async (t) => {
  const dir = await tempDir(t);
  const agentsPath = join(dir, "AGENTS.md");
  await writeFile(agentsPath, `# Project\n\nbefore\n\n${START}\nstale content\n${END}\n\nafter\n`);
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeDeliveryRunnerConfig(dir, enabledConfig);

  await updateManagedDeliveryInstructions(dir);
  const next = await readFile(agentsPath, "utf8");
  assert.match(next, /^# Project$/m);
  assert.match(next, /^before$/m);
  assert.match(next, /^after$/m);
  assert.doesNotMatch(next, /stale content/);
  assert.match(next, /^- status: enabled$/m);
  const before = next.slice(0, next.indexOf(START));
  const after = next.slice(next.indexOf(END) + END.length);
  assert.equal(before, "# Project\n\nbefore\n\n");
  assert.equal(after, "\n\nafter\n");

  // 幂等：再跑一次字节不动（无变更不写）。
  const again = await readFile(agentsPath, "utf8");
  await updateManagedDeliveryInstructions(dir);
  assert.equal(await readFile(agentsPath, "utf8"), again);
});

test("absent markers: file stays byte-identical (never created here)", async (t) => {
  const dir = await tempDir(t);
  const agentsPath = join(dir, "AGENTS.md");
  const source = "# Project\n\nno managed delivery block here\n";
  await writeFile(agentsPath, source);

  await updateManagedDeliveryInstructions(dir);
  assert.equal(await readFile(agentsPath, "utf8"), source);
});

test("markers deleted after a render: silently stops (no re-creation)", async (t) => {
  const dir = await tempDir(t);
  const agentsPath = join(dir, "AGENTS.md");
  await writeFile(agentsPath, `# Project\n\n${START}\nold\n${END}\n`);
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeDeliveryRunnerConfig(dir, enabledConfig);
  await updateManagedDeliveryInstructions(dir);

  // 用户删掉标记（保留其余内容）→ 再跑不重建。
  const stripped = (await readFile(agentsPath, "utf8"))
    .slice(0, `# Project\n\n`.length) + "\nplain now\n";
  await writeFile(agentsPath, stripped);
  await updateManagedDeliveryInstructions(dir);
  assert.equal(await readFile(agentsPath, "utf8"), stripped);
  assert.doesNotMatch(await readFile(agentsPath, "utf8"), /workspace-managed:delivery/);
});

test("missing AGENTS.md: no-op, file not created", async (t) => {
  const dir = await tempDir(t);
  await updateManagedDeliveryInstructions(dir);
  await assert.rejects(readFile(join(dir, "AGENTS.md"), "utf8"), /ENOENT/);
});

// final-fix I2（2026-10-26）：托管块此前对 AGENTS.md 做无锁读-改-写。并发安全
// 难以单测——按源断言钉住：整个读-改-写（readFile … writeAtomic）在
// withWorkspaceWriteLock 内（双层锁，spec §8.2；writeAtomic 自身不取锁，无嵌套）。
test("AGENTS.md read-modify-write runs under the workspace write lock (source assertion)", async () => {
  const src = await readFile(new URL("./delivery-managed.ts", import.meta.url), "utf8");
  const idxLock = src.indexOf("withWorkspaceWriteLock(workspacePath");
  const idxRead = src.indexOf("await readFile(agentsPath");
  const idxWrite = src.indexOf("await writeAtomic(agentsPath");
  assert.ok(idxLock >= 0, "updateManagedDeliveryInstructions takes the workspace write lock");
  assert.ok(idxRead > idxLock && idxWrite > idxRead, "lock wraps the whole read-modify-write");
});

// backlog-clearing T2（2026-10-27）：AGENTS.md 读 catch 收窄——ENOENT（文件
// 不存在）保持静默 no-op；其他读错误（EACCES 等）console.error 后照样放行
// （块同步永不打死保存，但失败必须可见）。读错误注入（chmod 000）在单测里
// 不可靠（root 直通、平台语义漂移）——按源断言钉住区分逻辑。
test("AGENTS.md read catch is narrowed: silent only for ENOENT, others logged (source assertion)", async () => {
  const src = await readFile(new URL("./delivery-managed.ts", import.meta.url), "utf8");
  const readIdx = src.indexOf("await readFile(agentsPath");
  assert.ok(readIdx >= 0, "readFile(agentsPath) present");
  const tail = src.slice(readIdx, src.indexOf("if (!current.includes(DELIVERY_MANAGED_START"));
  assert.ok(tail.length > 0 && tail.length < 1200, "narrow window: the read catch block");
  assert.match(tail, /code === "ENOENT"/, "ENOENT distinguished from other read errors");
  assert.match(tail, /console\.error/, "non-ENOENT read errors are logged, not silent");
});
