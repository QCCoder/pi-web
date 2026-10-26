// Final-fix E（2026-10-26）：Task 5 手工 grep 守卫的持久化（源断言用例）。
// seam-repositioning 终形：delivery-runner 的 lib 源码里**除 role-templates.ts
// （模板本就是要播进工作区的干活内容）外**不得再出现——
//   1. 工作区专属事实（constraints.md / budget.md / jdk / mvn / npm /
//      origin/master / cargoware）——项目事实只住工作区 AGENTS.md 与剧本；
//   2. 已删的四段角色合同符号（buildRoleContract / DESIGNER_CONTRACT /
//      readDesignerProfileModel）——角色差异全归剧本，不得从 git 历史复活。
// 命中即红：新增 lib 源文件自动纳入扫描（readdir 全量 *.ts）。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/** 工作区专属事实守卫（与 role-templates.test.mjs 的 WS_FACT_GUARD 同一模式）。 */
const WS_FACT_GUARD = /constraints\.md|budget\.md|jdk|mvn|npm|origin\/master|cargoware/i;
/** 已删四段合同的符号守卫（历史复活检测）。 */
const DEAD_CONTRACT_GUARD = /buildRoleContract|DESIGNER_CONTRACT|readDesignerProfileModel/;

test("guard patterns are live (self-check against known-positive strings)", () => {
  // 防 regex 抄错/退化成永绿：守卫必须能命中正例。
  for (const fact of ["npm run build", "mvn -q test", "origin/master", "constraints.md", "budget.md", "jdk", "cargoware"]) {
    assert.ok(WS_FACT_GUARD.test(fact), `WS_FACT_GUARD must match ${fact}`);
  }
  for (const symbol of ["buildRoleContract", "DESIGNER_CONTRACT", "readDesignerProfileModel"]) {
    assert.ok(DEAD_CONTRACT_GUARD.test(symbol), `DEAD_CONTRACT_GUARD must match ${symbol}`);
  }
});

test("delivery-runner lib sources (except role-templates.ts) carry no workspace facts or dead contract symbols", async () => {
  const dir = new URL(".", import.meta.url);
  const files = (await readdir(dir))
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => name !== "role-templates.ts");
  // 目录健全性：守卫确实扫到了 lib 面（词表/装配/池等已知文件在场）。
  assert.ok(files.length >= 10, `expected to scan the delivery-runner lib sources, found ${files.length}`);
  for (const name of ["config.ts", "role-session.ts", "role-preview.ts", "pool.ts", "claim.ts"]) {
    assert.ok(files.includes(name), `${name} must be covered by the guard`);
  }
  for (const name of files) {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, WS_FACT_GUARD, `${name} must not embed workspace-specific facts`);
    assert.doesNotMatch(source, DEAD_CONTRACT_GUARD, `${name} must not resurrect the deleted role contracts`);
  }
});
