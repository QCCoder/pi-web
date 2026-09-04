/**
 * grill 卡片协议（grilling 定稿 2026-09-04）。
 *
 * dev-loop 执行会话按 SKILL.md §3 在 assistant 消息里嵌 ```grill 代码块：
 *   ```grill
 *   {"n":2,"total":5,"question":"…人话问题…","options":["是","否"],"recommended":"是"}
 *   ```
 * pi-web 检测到该块即渲染成交互确认卡（选项按钮 + 倒计时 + 自由输入），
 * 点击经既有发送路径把答复作为普通用户消息送回会话——会话侧合同零改动，
 * 卡片只是「另一副键盘」（其余读者：终端原文、scripts/grill-watch.py）。
 */

export interface GrillQuestion {
  /** 阶段标签（会话直供人话，卡片照显；如「需求确认」「方案确认」） */
  stage?: string;
  /** 题号（1 起） */
  n?: number;
  /** 总题数 */
  total?: number;
  /** 人话问题文本（必填，否则不渲染卡片） */
  question: string;
  /** 选项（可与 recommended 并存；缺省为 [是, 否]） */
  options?: string[];
  /** 推荐项（必须是 options 之一或任意短句） */
  recommended?: string;
  /** 超时分钟数（watcher 代答窗口；缺省 2） */
  deadlineMin?: number;
}

export interface ParsedGrillMessage {
  grill: GrillQuestion;
  /** grill 块之前的正文（照常走 Markdown 渲染） */
  before: string;
  /** grill 块之后的正文 */
  after: string;
}

export const GRILL_TIMEOUT_MIN_DEFAULT = 2;

const GRILL_BLOCK_RE = /```grill[ \t]*\r?\n([\s\S]*?)\r?\n```/;

/** 从 assistant 文本块中解析 ```grill 块。无块 / JSON 非法 / 缺 question → null（按普通文本渲染）。 */
export function parseGrillMessage(text: string): ParsedGrillMessage | null {
  if (!text || !text.includes("```grill")) return null;
  const match = GRILL_BLOCK_RE.exec(text);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const grill = parsed as GrillQuestion;
  if (typeof grill.question !== "string" || !grill.question.trim()) return null;
  const options = Array.isArray(grill.options)
    ? grill.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0)
    : [];
  const normalized: GrillQuestion = {
    ...grill,
    stage: typeof grill.stage === "string" && grill.stage.trim() ? grill.stage.trim() : undefined,
    options: options.length > 0 ? options : ["是", "否"],
    recommended: typeof grill.recommended === "string" ? grill.recommended : undefined,
    deadlineMin: typeof grill.deadlineMin === "number" && grill.deadlineMin > 0 ? grill.deadlineMin : GRILL_TIMEOUT_MIN_DEFAULT,
  };
  const end = match.index + match[0].length;
  return { grill: normalized, before: text.slice(0, match.index), after: text.slice(end) };
}

/** 卡片答复统一话术：会话（LLM）靠它把答复映射回 GRILL.md 对应条目。 */
export function grillReplyText(question: string, value: string): string {
  return `【grill 答复】${question}：${value}`;
}
