/** pi 工作区布局约定（2026-09 一套约定）：pi 的机制文件与数据统一收纳在工作区根
 *  的 `.pi/` 下；工作区根留给人的内容（代码仓、知识库、文档）。路径唯一源 ——
 *  pi-loop 宿主（daemon spawner / beat CLI）与 pi-web 服务端共用，调用点禁止手拼。 */
import { join } from "node:path";

/** `.pi/loops/<name>/` — LOOP.md / STATE.md / PAUSED / .lastrun / .round.lock 所在目录。 */
export function loopDirPath(workspacePath: string, loopName: string): string {
  return join(workspacePath, ".pi", "loops", loopName);
}

/** `.pi/loops/` — 各 loop 目录的父目录。 */
export function loopsDirPath(workspacePath: string): string {
  return join(workspacePath, ".pi", "loops");
}

/** `.pi/loop/pause-all` — 全工作区 loop 停机旗（原根级 `loop-pause-all`）。 */
export function haltMarkerPath(workspacePath: string): string {
  return join(workspacePath, ".pi", "loop", "pause-all");
}

/** `.pi/loop/` — 根级共享宪法目录（constraints.md / budget.md）。 */
export function constitutionDirPath(workspacePath: string): string {
  return join(workspacePath, ".pi", "loop");
}

/** `.pi/skills/<pattern>/` — 项目技能合同目录（pi 原生发现 `<cwd>/.pi/skills/`）。 */
export function skillDirPath(workspacePath: string, pattern: string): string {
  return join(workspacePath, ".pi", "skills", pattern);
}

/** `.pi/work-items/` — 工作项存储根（requirements/bugs 在其下；web 侧共用）。 */
export function workItemsRootPath(workspacePath: string): string {
  return join(workspacePath, ".pi", "work-items");
}
