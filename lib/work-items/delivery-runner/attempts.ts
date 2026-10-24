// Phase-2 Task 3: claim 运行态与 attempt 审计（spec 2026-10-24-phase-two §5.2/§5.4）。
//
// 文件布局（itemPath = 工作项目录，如 <ws>/.pi/work-items/requirements/REQ-0001-x）：
//   <item>/delivery/runtime/claim.json              活动领取（运行态，advisory）
//   <item>/delivery/runtime/automation-paused.json  连续失败暂停标记（运行态，advisory）
//   <item>/delivery/attempts/<attemptId>.json       追加式 attempt 审计（含中断记录）
//
// 设计要点：
//   - claim/paused 是【同步】读写（brief 契约）：claim 事务与心跳续约走
//     read-modify-write 的紧凑路径；本地 writeAtomicSync 镜像 service.ts 的
//     writeAtomic 习语（父目录 mkdir -p + 唯一 tmp + wx 独占 + rename + 失败清理）。
//     attempt 审计是【异步】追加/列举，直接复用 service.ts 的 writeAtomic。
//   - ownerToken 明文只存在于进程内 role grant，永不落盘——claim.json 只存
//     sha256 hash（hashOwnerToken），泄漏磁盘文件不能伪造心跳/释放。
//   - runtime/ 是 advisory 运行态（gitignored、可丢失）：读路径对缺失/不可读/
//     坏 JSON 一律按「无」处理（executions.ts 的宽松习语——坏文件不阻塞投影
//     与恢复）；重领安全由 claim 事务的 phase 流转（intake→design）兜底，
//     不单靠 claim.json 在场。
//   - attempt 记录是审计事实：resolveInterruptions 只清 needsAttention + 记
//     诊断（executions.ts 的 resolve 习语，逐文件 tmp+rename），记录本身永不删除。
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createUlid } from "../../workspaces/id.ts";
import { contentDigest } from "../delivery-types.ts";
import { WorkItemValidationError } from "../errors.ts";
import { writeAtomic } from "../service.ts";

export interface ClaimState {
  attemptId: string;
  generation: number;
  role: "designer";
  sessionId: string;
  claimedAt: string;
  lastSeenAt: string;
  requirementDigest: string;
  /** sha256 hex——明文 token 只存在于进程内 role grant，永不落盘。 */
  ownerTokenHash: string;
  lastRequest?: { requestId: string; at: string };
}

export interface AttemptRecord {
  attemptId: string;
  generation: number;
  role: "designer";
  sessionId: string;
  workspacePath: string;
  key: string;
  claimedAt: string;
  endedAt?: string;
  outcome?: "submitted" | "failed" | "interrupted";
  reason?: string;
  requirementDigest: string;
  needsAttention?: boolean;
  diagnostic?: { checkedAt?: string; actor?: string };
}

export interface PausedInfo {
  at: string;
  reason: string;
  count: number;
}

// ------------------------------------------------------------------ paths

export function claimFilePath(itemPath: string): string {
  return join(itemPath, "delivery", "runtime", "claim.json");
}

export function attemptsDir(itemPath: string): string {
  return join(itemPath, "delivery", "attempts");
}

export function pausedFilePath(itemPath: string): string {
  return join(itemPath, "delivery", "runtime", "automation-paused.json");
}

// ------------------------------------------------- sync atomic write (claim/paused)

/** service.ts writeAtomic 的同步镜像（claim/paused 契约是同步签名）。 */
function writeAtomicSync(filePath: string, content: string): void {
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

/** 宽松读：缺失/不可读/坏 JSON/坏形状 → null（runtime/ 是 advisory 运行态）。 */
function readJsonFileSync(filePath: string): Record<string, unknown> | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- claim

export function readClaim(itemPath: string): ClaimState | null {
  const parsed = readJsonFileSync(claimFilePath(itemPath));
  if (parsed === null || typeof parsed.attemptId !== "string") return null;
  return parsed as unknown as ClaimState;
}

export function writeClaim(itemPath: string, claim: ClaimState): void {
  writeAtomicSync(claimFilePath(itemPath), JSON.stringify(claim, null, 2) + "\n");
}

export function clearClaim(itemPath: string): void {
  rmSync(claimFilePath(itemPath), { force: true });
}

// ----------------------------------------------------------------- attempts

const WORK_ITEM_KEY_RE = /^(REQ|BUG)-\d{4,}$/;
const WORK_ITEM_DIRECTORY_RE = /^((?:REQ|BUG)-\d{4,})(?:-|$)/;
const ATTEMPT_ID_RE = /^[\w-]+$/; // ULID 及同族文件名安全 id；拒绝路径逃逸

/** key → 存储类型目录（REQ→requirements / BUG→bugs，同 service.ts 习语）。 */
function itemDirectoryNameFromKey(key: string): "requirements" | "bugs" {
  if (!WORK_ITEM_KEY_RE.test(key)) {
    throw new WorkItemValidationError(`Invalid Work Item key: ${key}`);
  }
  return key.startsWith("REQ-") ? "requirements" : "bugs";
}

/** workspacePath+key → 工作项目录。镜像 service.ts 的 findWorkItemDirectory：
 *  扫类型目录匹配 `<KEY>-*`（slug 后缀未知）；无命中/目录缺失回退裸 KEY 路径
 *  （writeAtomic 会带上父目录）。 */
async function resolveItemDirectory(workspacePath: string, key: string): Promise<string> {
  const root = join(workspacePath, ".pi", "work-items", itemDirectoryNameFromKey(key));
  const exactPath = join(root, key);
  try {
    const entries: Dirent[] = await readdir(root, { withFileTypes: true });
    const match = entries.find(
      (entry) => entry.isDirectory() && entry.name.match(WORK_ITEM_DIRECTORY_RE)?.[1] === key,
    );
    return match ? join(root, match.name) : exactPath;
  } catch {
    return exactPath;
  }
}

function isAttemptShape(value: unknown): value is AttemptRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.attemptId === "string" && typeof record.key === "string";
}

export async function writeAttempt(record: AttemptRecord): Promise<void> {
  if (!ATTEMPT_ID_RE.test(record.attemptId)) {
    throw new WorkItemValidationError(
      `Invalid attempt id (must be filename-safe): ${record.attemptId}`,
    );
  }
  const itemPath = await resolveItemDirectory(record.workspacePath, record.key);
  await writeAtomic(
    join(attemptsDir(itemPath), `${record.attemptId}.json`),
    JSON.stringify(record, null, 2) + "\n",
  );
}

/** 全量审计（按 attemptId = ULID 时间序升序）。坏文件跳过，永不抛。 */
export async function listAttempts(itemPath: string): Promise<AttemptRecord[]> {
  const dir = attemptsDir(itemPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: AttemptRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (!isAttemptShape(record)) continue;
      records.push(record);
    } catch {
      // malformed file — skip (audit listing never throws on bad json)
    }
  }
  records.sort((left, right) => left.attemptId.localeCompare(right.attemptId));
  return records;
}

/** 未确认中断（needsAttention）——池子的中断门禁与详情页「重新检查并恢复」读它。 */
export async function listPendingInterruptions(itemPath: string): Promise<AttemptRecord[]> {
  const records = await listAttempts(itemPath);
  return records.filter((record) => record.needsAttention === true);
}

/** 解除中断：只动 needsAttention 记录——审计保留，逐文件 tmp+rename 写回，
 *  返回解除数（无可解除 = 0）。习语对齐 executions.ts 的 resolveExecutionRecords。 */
export async function resolveInterruptions(
  itemPath: string,
  patch: {
    outcome?: "interrupted";
    needsAttention: false;
    diagnostic?: { checkedAt: string; actor?: string };
  },
): Promise<number> {
  const dir = attemptsDir(itemPath);
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
    let record: unknown;
    try {
      record = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    if (!isAttemptShape(record) || record.needsAttention !== true) continue;
    const updated: AttemptRecord = {
      ...record,
      ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
      needsAttention: false,
      diagnostic: { ...record.diagnostic, ...patch.diagnostic },
    };
    await writeAtomic(path, JSON.stringify(updated, null, 2) + "\n");
    resolved += 1;
  }
  return resolved;
}

// ------------------------------------------------------------------ paused

export function readPaused(itemPath: string): PausedInfo | null {
  const parsed = readJsonFileSync(pausedFilePath(itemPath));
  if (
    parsed === null ||
    typeof parsed.at !== "string" ||
    typeof parsed.reason !== "string" ||
    typeof parsed.count !== "number"
  ) {
    return null;
  }
  return parsed as unknown as PausedInfo;
}

export function writePaused(itemPath: string, info: PausedInfo): void {
  writeAtomicSync(pausedFilePath(itemPath), JSON.stringify(info, null, 2) + "\n");
}

export function clearPaused(itemPath: string): void {
  rmSync(pausedFilePath(itemPath), { force: true });
}

// -------------------------------------------------------------- owner token

/** sha256 hex（镜像 delivery-types 的 contentDigest——同一实现，明文 token
 *  只在进程内 role grant 存活，claim.json 只落 hash）。 */
export function hashOwnerToken(token: string): string {
  return contentDigest(token);
}
