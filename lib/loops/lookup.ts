/** 管理/操作路由共用的 loop 名解析（web spec §4/§5.2）。
 *  按 loopName（name 字段，缺省=目录名）匹配，回落目录名——绑定存的是名（S1），
 *  一切文件操作仍以 declaration.dir（目录）为准（H7）。 */
import { basename } from "node:path";
import { discoverKitLoops, type LoopDeclaration } from "../../packages/pi-loop/protocol.ts";

export function findKitLoopByName(workspacePath: string, name: string): LoopDeclaration | undefined {
  return discoverKitLoops(workspacePath, { includePaused: true })
    .find((declaration) => declaration.loopName === name || basename(declaration.dir) === name);
}
