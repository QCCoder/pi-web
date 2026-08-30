#!/usr/bin/env node
/** pi-loop CLI — kit loop 的心跳宿主（design: docs/pi-loop-host-design.md §4）。 */
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { discoverKitLoops } from "./protocol.ts";
import { runNow } from "./fire.ts";
import { beatRoot, beatRoundRunner, stopRound } from "./beat.ts";

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
    const declaration = discoverKitLoops(root, { includePaused: true }).find((d) => d.loopName === name)
      ?? die(`未找到 loop「${name}」（${join(root, "loops", name, "LOOP.md")}）`, 1);
    const item = opt("--item");
    const result = await runNow(declaration, { pid: process.pid, host: hostname(), kind: "beat" },
      () => beatRoundRunner(declaration, item ? { extraInstructions: `本轮优先处理 ${item}（工作项绑定触发）` } : {}));
    console.log(result === "fired" ? `[pi-loop] 已起轮 ${name}` : `[pi-loop] ${name} 本轮已在跑`);
    process.exit(result === "fired" ? 0 : 1);
  }
  if (command === "stop") {
    const outcome = await stopRound(root, args[0] ?? die("用法: pi-loop stop <name>"));
    console.log(outcome.message);
    process.exit(outcome.ok ? 0 : 1);
  }
  if (command === "pause" || command === "resume") {
    const marker = join(root, "loops", args[0] ?? die(`用法: pi-loop ${command} <name>`), "PAUSED");
    if (command === "pause") writeFileSync(marker, "");
    else { try { unlinkSync(marker); } catch { /* 本就未暂停 */ } }
    console.log(`[pi-loop] ${command === "pause" ? "已暂停" : "已恢复"} ${args[0]}`);
    return;
  }
  if (command === "watch") {
    console.log(`[pi-loop] watch ${root}（30s tick，Ctrl-C 退出）`);
    const tick = () => void beatRoot(root).catch((e) => console.error("[pi-loop] tick failed:", e));
    tick();
    setInterval(tick, 30_000);
    return;
  }
  die("用法: pi-loop <beat|watch|run|stop|pause|resume> ...（status/init 随下一任务交付）");
}

void main();
