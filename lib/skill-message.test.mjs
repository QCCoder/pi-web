import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseSkillMessage,
  sanitizeSkillUserContent,
  skillCommandText,
  skillMessageTitle,
} = await jiti.import("./skill-message.ts");

const expanded = `<skill name="grilling" location="/Users/example/.pi/agent/skills/grilling/SKILL.md">
References are relative to /Users/example/.pi/agent/skills/grilling.

Interview me relentlessly.

Ask one question at a time.
</skill>

为什么会显示完整 Skill？`;

test("parses pi's expanded skill command and reconstructs the original input", () => {
  const parsed = parseSkillMessage(expanded);

  assert.deepEqual(parsed, {
    name: "grilling",
    location: "/Users/example/.pi/agent/skills/grilling/SKILL.md",
    baseDir: "/Users/example/.pi/agent/skills/grilling",
    instructions: "Interview me relentlessly.\n\nAsk one question at a time.",
    userMessage: "为什么会显示完整 Skill？",
  });
  assert.equal(skillCommandText(parsed), "/skill:grilling 为什么会显示完整 Skill？");
  assert.equal(skillMessageTitle(expanded), "为什么会显示完整 Skill？");
});

test("uses the skill command as the title when invocation has no arguments", () => {
  const withoutArgs = expanded.replace("\n\n为什么会显示完整 Skill？", "");
  const parsed = parseSkillMessage(withoutArgs);

  assert.equal(parsed.userMessage, undefined);
  assert.equal(skillCommandText(parsed), "/skill:grilling");
  assert.equal(skillMessageTitle(withoutArgs), "/skill:grilling");
});

test("leaves malformed and hand-written skill-like content untouched", () => {
  const malformed = `<skill name="grilling" location="somewhere">\nuser text\n</skill>`;

  assert.equal(parseSkillMessage(malformed), null);
  assert.equal(skillMessageTitle(malformed), malformed);
});

test("sanitizes expanded skill instructions from title-model content", () => {
  assert.equal(sanitizeSkillUserContent(expanded), "为什么会显示完整 Skill？");

  const image = { type: "image", source: { type: "base64", data: "abc" } };
  const content = [{ type: "text", text: expanded }, image];
  const sanitized = sanitizeSkillUserContent(content);

  assert.equal(sanitized[0].text, "为什么会显示完整 Skill？");
  assert.equal(sanitized[1], image);
  assert.equal(content[0].text, expanded);
});
