/**
 * 聊天输入框的「文件附件」（区别于内联 base64 的图片附件）。pi 的消息协议
 * 只支持图片内联（ImageContent），任意文件走「上传落盘 + 路径引用」：选中
 * 后立即 POST /api/uploads 落到 ~/.pi/agent/uploads/，发送时把绝对路径以
 * Markdown 链接追加到消息文本尾部——渲染端可点击打开（/api/files 白名单含
 * uploads 根），模型读原始文本拿到路径后用 read/bash 自行消费。
 */

export const MAX_ATTACHED_FILES = 10;
export const MAX_ATTACHED_FILE_BYTES = 25 * 1024 * 1024;

export interface AttachedFile {
  /** 上传完成后的服务器绝对路径；uploading 期间为空串。 */
  path: string;
  /** 原始文件名（显示 + 链接标签）。 */
  name: string;
  size: number;
  /** 上传进行中（尚未拿到 path，发送被阻塞）。 */
  uploading?: boolean;
}

/** Markdown 链接标签安全化：剥掉会破坏 [label](href) 语法的括号。 */
export function markdownLinkLabel(name: string): string {
  return name.replace(/[\[\]()`]/g, " ").replace(/\s+/g, " ").trim() || "file";
}

/** 附件尺寸人话：B / KB / MB。 */
export function formatFileBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 单个附件的引用行：`[附件 <name>](<abs path>)` —— 渲染为可点击链接，
 *  模型读原始文本拿到绝对路径。 */
export function attachmentReferenceLine(file: AttachedFile): string {
  return `[附件 ${markdownLinkLabel(file.name)}](${file.path})`;
}

/**
 * 把已完成上传的附件引用追加到消息文本尾部（发送前调用）。每文件一行，
 * 与正文之间空一行；没有就绪附件时原样返回。上传中的附件不进引用
 * （发送路径应先阻塞在 uploading 上）。
 */
export function appendAttachmentReferences(text: string, files: AttachedFile[]): string {
  const ready = files.filter((file) => !file.uploading && file.path);
  if (ready.length === 0) return text;
  const block = ready.map(attachmentReferenceLine).join("\n");
  const base = text.trim();
  return base ? `${base}\n\n${block}` : block;
}
