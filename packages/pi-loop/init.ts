import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify, parse } from "yaml";
import { writeLastrun } from "./due.ts";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "kit", "templates", "basic");

export function initLoop(root: string, opts: {
  name: string; cron: string; pattern?: string; level?: "L1" | "L2" | "L3"; maxMinutes?: number; timezone?: string;
}): void {
  const dir = join(root, "loops", opts.name);
  mkdirSync(dir, { recursive: true });
  // root 宪法（存在即跳过 — 人工内容优先）
  for (const file of ["loop-constraints.md", "loop-budget.md"]) {
    if (!existsSync(join(root, file))) copyFileSync(join(TEMPLATES, "root", file), join(root, file));
  }
  // loop 五件套（存在即跳过 — 不得覆盖既有 loop）
  for (const file of ["STATE.md", "loop-ledger.json"]) {
    if (!existsSync(join(dir, file))) copyFileSync(join(TEMPLATES, "loop", file), join(dir, file));
  }
  // SKILL.md 骨架（spec §4）：.agents/skills/<pattern>/，pattern 缺省取 name（protocol.ts 同规则）；存在即跳过
  const pattern = opts.pattern ?? opts.name;
  const skillPath = join(root, ".agents", "skills", pattern, "SKILL.md");
  if (!existsSync(skillPath)) {
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, readFileSync(join(TEMPLATES, "skill", "SKILL.md"), "utf8").replaceAll("{{pattern}}", pattern));
  }
  // LOOP.md：模板 frontmatter + 定制（存在即跳过 — 与 STATE/ledger 同幂等规则，不得清写正文）
  const loopPath = join(dir, "LOOP.md");
  if (!existsSync(loopPath)) {
    const raw = readFileSync(join(TEMPLATES, "loop", "LOOP.md"), "utf8");
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) throw new Error("模板 LOOP.md 损坏");
    const front = parse(match[1]) as Record<string, unknown>;
    front.name = opts.name;
    front.cron = opts.cron;
    if (opts.pattern) front.pattern = opts.pattern;
    if (opts.level) front.level = opts.level;
    if (opts.maxMinutes) front.max_minutes = opts.maxMinutes;
    if (opts.timezone) front.timezone = opts.timezone;
    // 正文含 /skill:{{pattern}} 指针 — 与 SKILL.md 同规则替换
    writeFileSync(loopPath, `---\n${stringify(front)}---\n${match[2].replaceAll("{{pattern}}", pattern)}`);
  }
  writeLastrun(dir, new Date()); // 首轮等自然槽（host spec §6）
}
