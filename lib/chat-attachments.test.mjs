import test from "node:test";
import assert from "node:assert/strict";

test("markdownLinkLabel strips bracket/paren/backtick chars that break [label](href)", async () => {
  const { markdownLinkLabel } = await import("./chat-attachments.ts");
  assert.equal(markdownLinkLabel("report.pdf"), "report.pdf");
  assert.equal(markdownLinkLabel("a[b].pdf"), "a b .pdf");
  assert.equal(markdownLinkLabel("weird((name)).md"), "weird name .md");
  assert.equal(markdownLinkLabel("`x`.py"), "x .py");
  // 全剥光的极端名兜底
  assert.equal(markdownLinkLabel("[]()"), "file");
});

test("attachmentReferenceLine renders [附件 name](abs path)", async () => {
  const { attachmentReferenceLine } = await import("./chat-attachments.ts");
  assert.equal(
    attachmentReferenceLine({ path: "/home/u/.pi/agent/uploads/20260912/a-report.pdf", name: "a-report.pdf", size: 12 }),
    "[附件 a-report.pdf](/home/u/.pi/agent/uploads/20260912/a-report.pdf)",
  );
});

test("appendAttachmentReferences: ready files appended, uploading skipped, empty text gets block only", async () => {
  const { appendAttachmentReferences } = await import("./chat-attachments.ts");
  const ready = { path: "/u/f/a.txt", name: "a.txt", size: 1 };
  const ready2 = { path: "/u/f/b.pdf", name: "b.pdf", size: 2 };
  const uploading = { path: "", name: "c.zip", size: 3, uploading: true };

  // 无附件 → 原样返回
  assert.equal(appendAttachmentReferences("hello", []), "hello");
  // 只有上传中 → 原样返回
  assert.equal(appendAttachmentReferences("hello", [uploading]), "hello");
  // 有正文 → 空行 + 每文件一行
  assert.equal(
    appendAttachmentReferences("hello", [ready, uploading, ready2]),
    "hello\n\n[附件 a.txt](/u/f/a.txt)\n[附件 b.pdf](/u/f/b.pdf)",
  );
  // 无正文 → 引用块即全文
  assert.equal(
    appendAttachmentReferences("", [ready]),
    "[附件 a.txt](/u/f/a.txt)",
  );
});

test("formatFileBytes: human sizes, guards non-finite/negative", async () => {
  const { formatFileBytes } = await import("./chat-attachments.ts");
  assert.equal(formatFileBytes(512), "512 B");
  assert.equal(formatFileBytes(2048), "2 KB");
  assert.equal(formatFileBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(formatFileBytes(-1), "");
  assert.equal(formatFileBytes(Number.NaN), "");
});
