/** 执行中断记录（spec §5.4）：宿主关停时为在飞 loop 轮写
 *  `<workspace>/.pi/runtime/executions/<runId>.json`；恢复期据此阻塞该 loop
 *  的新轮，直到「重新检查并恢复」证明旧命令已停止。纯 fs，无 daemon 依赖。 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PsRow } from "../../packages/pi-loop/reap.ts";

export interface ExecutionRecord {
  schemaVersion: 1;
  runId: string;                 // = 轮会话 sessionId
  kind: "loop-round";
  loopName: string;
  sessionId: string;
  workspacePath: string;
  host: { pid: number; hostname: string };
  startedAt: string;
  stoppedAt: string;
  stopResult: "interrupted-on-shutdown" | "recovered-auto" | "recovered-manual" | "confirmed-dead";
  needsAttention: boolean;
  diagnostic?: { checkedAt?: string; foundPids?: number[]; actor?: string };
}

export function executionsDir(workspacePath: string): string {
  return join(workspacePath, ".pi", "runtime", "executions");
}

export async function writeExecutionRecord(record: ExecutionRecord): Promise<void> {
  const dir = executionsDir(record.workspacePath);
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, `${record.runId}.json`);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  await rename(tmpPath, finalPath);
}

export async function listPendingExecutionRecords(
  workspacePath: string,
  loopName?: string,
): Promise<ExecutionRecord[]> {
  const dir = executionsDir(workspacePath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: ExecutionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(dir, name), "utf8")) as ExecutionRecord;
      if (record.schemaVersion !== 1 || !record.needsAttention) continue;
      if (loopName && record.loopName !== loopName) continue;
      records.push(record);
    } catch {
      // malformed file — skip (never blocks recovery on bad json)
    }
  }
  return records;
}

export async function resolveExecutionRecords(
  workspacePath: string,
  loopName: string,
  patch: Partial<Pick<ExecutionRecord, "stopResult" | "needsAttention" | "diagnostic">>,
): Promise<number> {
  const dir = executionsDir(workspacePath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let resolved = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let record: ExecutionRecord;
    try {
      record = JSON.parse(await readFile(path, "utf8")) as ExecutionRecord;
    } catch {
      continue;
    }
    if (record.schemaVersion !== 1 || record.loopName !== loopName || !record.needsAttention) continue;
    const updated: ExecutionRecord = { ...record, ...patch, diagnostic: { ...record.diagnostic, ...patch.diagnostic } };
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
    await rename(tmpPath, path);
    resolved += 1;
  }
  return resolved;
}

export interface DetectDeps {
  lister?: () => PsRow[];
  cwdOf?: (pid: number) => string | undefined;
}

/** 只读探测（不杀）：ppid=1（被 reparent）+ build/shell 命令 + cwd 在工作区内。
 *  复用 pi-loop/reap 的纯函数与 ps 快照；探测失败返回 []（无法证明 ≠ 已证明）。 */
export async function detectSurvivingRoundProcesses(
  workspacePath: string,
  deps: DetectDeps = {},
): Promise<number[]> {
  const { listAllProcesses, pidCwd, isBuildOrShellCommand, isCwdInWorkspace } = await import("../../packages/pi-loop/reap.ts");
  const lister = deps.lister ?? listAllProcesses;
  const cwdOf = deps.cwdOf ?? pidCwd;
  const found: number[] = [];
  for (const row of lister()) {
    if (row.ppid !== 1 || row.pid === process.pid) continue;
    if (!isBuildOrShellCommand(row.command)) continue;
    if (isCwdInWorkspace(cwdOf(row.pid), workspacePath)) found.push(row.pid);
  }
  return found;
}
