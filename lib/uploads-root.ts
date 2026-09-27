import fs from "fs";
import { homedir } from "os";
import path from "path";
import { randomBytes } from "crypto";

/**
 * 聊天文件附件的上传家（server-only）。落在 pi 数据目录下的 `uploads/`——
 * 全局、独立于任何项目/工作区 git 仓库（不制造未跟踪文件噪音），路径引用
 * 对 agent 的 read/bash 直接可用；/api/files 的白名单含此根
 * （lib/file-access.ts），所以消息里的附件链接可点击预览。
 */
export function chatUploadsRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent");
  return path.join(agentDir, "uploads");
}

/** 上传文件名安全化：剥路径分量、去控制字符；空名/点名 → null（拒收）。 */
export function sanitizeUploadFileName(name: string): string | null {
  const base = (name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\0-\x1f\x7f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 上传落盘目标：`<root>/<yyyymmdd>/<HHmmss>-<rand6>-<name>`。按天分桶，
 * 秒级时间戳 + 随机段避免撞名（写入仍用 wx 兜底）。name 必须已经过
 * sanitizeUploadFileName。返回绝对路径；调用方 mkdir -p 其父目录。
 */
export function buildUploadDestination(root: string, now: Date, fileName: string): string {
  const d = now;
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const random = randomBytes(3).toString("hex");
  return path.join(root, day, `${time}-${random}-${fileName}`);
}

/** wx 写入 + mkdir -p 的薄封装（路由层用；独立出来便于测试桩替换）。 */
export function writeUploadFile(destination: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { flag: "wx" });
}
