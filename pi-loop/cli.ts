#!/usr/bin/env node
/** pi-loop CLI — kit loop 的心跳宿主（design: docs/pi-loop-host-design.md §4）。 */
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { discoverKitLoops } from "./protocol.ts";
import { runNow } from "./fire.ts";
import { beatRoot, beatRoundRunner, stopRound } from "./beat.ts";
import { initLoop } from "./init.ts";
import { collectStatus } from "./status.ts";

const [command, ...args] = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const root = opt("--root") ?? process.cwd();
const usage = 2;
const die = (message: string, code = usage): never => { console.error(message); process.exit(code); };

async function main(): Promise<void> {
  if (command === "beat") {
    const report = await beatRoot(root);
    for (const name of report.fired) console.log(`[pi-loop] fired  ${name}`);
    for (const name of report.skipped) console.log(`[pi-loop] skip   ${name}`);
    for (const failure of report.failed) console.error(`[pi-loop] FAILED ${failure.name}: ${failure.error}`);
    process.exit(report.failed.length > 0 ? 1 : 0);
  }
  if (command === "run") {
    const name = args[0];
    if (!name) die("用法: pi-loop run <name> [--item KEY] [--root .]");
    try {
      const declaration = discoverKitLoops(root, { includePaused: true }).find((d) => d.loopName === name)
        ?? die(`未找到 loop「${name}」（${join(root, "loops", name, "LOOP.md")}）`, 1);
      const item = opt("--item");
      const result = await runNow(declaration, { pid: process.pid, host: hostname(), kind: "beat" },
        () => beatRoundRunner(declaration, { manual: true, ...(item ? { extraInstructions: `本轮优先处理 ${item}（工作项绑定触发）` } : {}) }));
      console.log(result === "fired" ? `[pi-loop] 已起轮 ${name}` : `[pi-loop] ${name} 本轮已在跑`);
      process.exit(result === "fired" ? 0 : 1);
    } catch (error) {
      // 轮非零退出 → runNow reject；不接住会变 unhandled rejection 崩溃
      die(error instanceof Error ? error.message : String(error), 1);
    }
  }
  if (command === "stop") {
    const outcome = await stopRound(root, args[0] ?? die("用法: pi-loop stop <name>"));
    console.log(outcome.message);
    process.exit(outcome.ok ? 0 : 1);
  }
  if (command === "pause" || command === "resume") {
    const name = args[0] ?? die(`用法: pi-loop ${command} <name>`);
    // pause 写标记会 ENOENT 崩溃；resume 对不存在的 loop 会误报「已恢复」exit 0 — 同一目录守卫
    if (!existsSync(join(root, "loops", name))) {
      die(`未找到 loop「${name}」（${join(root, "loops", name)}）`, 1);
    }
    const marker = join(root, "loops", name, "PAUSED");
    if (command === "pause") writeFileSync(marker, "");
    else { try { unlinkSync(marker); } catch { /* 本就未暂停 */ } }
    console.log(`[pi-loop] ${command === "pause" ? "已暂停" : "已恢复"} ${name}`);
    return;
  }
  if (command === "status") {
    for (const entry of collectStatus(root)) {
      const state = entry.running ? "running" : entry.paused ? "paused" : `next ${entry.nextDue ?? "?"}`;
      console.log(`${entry.name}\t${entry.cron}\t${entry.level}\t${state}\tlast ${entry.lastRun ?? "-"}`);
    }
    return;
  }
  if (command === "init") {
    const name = opt("--name") ?? die("用法: pi-loop init --name <n> --cron <expr> [--pattern] [--level] [--max-minutes] [--timezone] [--root]");
    initLoop(root, {
      name,
      cron: opt("--cron") ?? die("--cron 必填"),
      pattern: opt("--pattern"),
      level: opt("--level") as "L1" | "L2" | "L3" | undefined,
      maxMinutes: opt("--max-minutes") ? Number(opt("--max-minutes")) : undefined,
      timezone: opt("--timezone"),
    });
    console.log(`[pi-loop] 已创建 loops/${name}（五件套 + .lastrun=now，首轮等自然槽）`);
    return;
  }
  if (command === "watch") {
    console.log(`[pi-loop] watch ${root}（30s tick，Ctrl-C 退出）`);
    const tick = () => void beatRoot(root).catch((e) => console.error("[pi-loop] tick failed:", e));
    tick();
    setInterval(tick, 30_000);
    return;
  }
  die("用法: pi-loop <beat|watch|run|stop|pause|resume|status|init> ...");
}

void main();
