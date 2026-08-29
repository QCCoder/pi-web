export interface ParsedSkillMessage {
  name: string;
  location: string;
  baseDir: string;
  /** The SKILL.md body snapshot that was sent to the model. */
  instructions: string;
  /** Arguments supplied after /skill:name, if any. */
  userMessage?: string;
}

/**
 * Parse the exact wrapper emitted by pi for `/skill:name` commands.
 * Deliberately returns null for partial or hand-written variants so UI cleanup
 * never hides arbitrary user content.
 */
export function parseSkillMessage(text: string): ParsedSkillMessage | null {
  const match = text.match(
    /^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to ([^\n]+)\.\n\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
  );
  if (!match) return null;

  return {
    name: match[1],
    location: match[2],
    baseDir: match[3],
    instructions: match[4],
    userMessage: match[5]?.trim() || undefined,
  };
}

export function skillCommandText(skill: Pick<ParsedSkillMessage, "name" | "userMessage">): string {
  return `/skill:${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ""}`;
}

/** The unambiguous pi wrapper header — a text starting with this was
 *  necessarily produced by `/skill:` expansion. */
const SKILL_WRAPPER_HEAD =
  /^<skill name="([^"]+)" location="([^"]+)">\nReferences are relative to [^\n]+\.\n/;

/** Text suitable for a fallback session title. */
export function skillMessageTitle(text: string): string {
  const skill = parseSkillMessage(text);
  if (skill) return skill.userMessage || `/skill:${skill.name}`;
  // Truncated copy of the wrapper (e.g. a firstMessage clipped at 400 chars
  // before the closing </skill>): the arguments after the wrapper are gone,
  // so the best readable title is the reconstructed command. Only fires on
  // the exact pi header shape and only when no closing tag survived — a
  // hand-written skill-like blob with </skill> is still left untouched.
  const head = text.match(SKILL_WRAPPER_HEAD);
  if (head && !text.includes("</skill>")) return `/skill:${head[1]}`;
  return text;
}

/**
 * Remove execution instructions from user content before asking a model to
 * title the conversation. Images and all non-skill text blocks are preserved.
 */
export function sanitizeSkillUserContent<T>(content: T): T {
  if (typeof content === "string") {
    return skillMessageTitle(content) as T;
  }
  if (!Array.isArray(content)) return content;

  return content.map((block) => {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      const text = skillMessageTitle(block.text);
      return text === block.text ? block : { ...block, text };
    }
    return block;
  }) as T;
}
