import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("sanitizeUploadFileName: strips path components and control chars, rejects dots/empty", async () => {
  const { sanitizeUploadFileName } = await import("./uploads-root.ts");
  assert.equal(sanitizeUploadFileName("report.pdf"), "report.pdf");
  assert.equal(sanitizeUploadFileName("/etc/passwd"), "passwd");
  assert.equal(sanitizeUploadFileName("..\\..\\win\\secret.txt"), "secret.txt");
  assert.equal(sanitizeUploadFileName("a\u0000b.txt"), "ab.txt");
  assert.equal(sanitizeUploadFileName("  spaced .txt  "), "spaced .txt");
  assert.equal(sanitizeUploadFileName(""), null);
  assert.equal(sanitizeUploadFileName(".."), null);
  assert.equal(sanitizeUploadFileName("."), null);
  // 中文文件名保留
  assert.equal(sanitizeUploadFileName("需求文档.pdf"), "需求文档.pdf");
});

test("buildUploadDestination: <root>/<yyyymmdd>/<HHmmss>-<rand6>-<name>, random differs per call", async () => {
  const { buildUploadDestination } = await import("./uploads-root.ts");
  const now = new Date(2026, 8, 12, 14, 30, 5); // 本地时区的 2026-09-12 14:30:05
  const a = buildUploadDestination("/root", now, "x.pdf");
  const b = buildUploadDestination("/root", now, "x.pdf");
  const dir = path.dirname(a);
  assert.equal(dir, path.join("/root", "20260912"));
  assert.match(path.basename(a), /^143005-[0-9a-f]{6}-x\.pdf$/);
  assert.notEqual(a, b); // 同秒同名的两次上传不撞
});

test("writeUploadFile integration: writes bytes, refuses overwrite (wx)", async () => {
  const { writeUploadFile } = await import("./uploads-root.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-uploads-"));
  try {
    const destination = path.join(root, "20260912", "120000-aaa111-hello.txt");
    writeUploadFile(destination, Buffer.from("one"));
    assert.equal(fs.readFileSync(destination, "utf8"), "one");
    assert.throws(() => writeUploadFile(destination, Buffer.from("two")));
    // 目录是递归建的
    assert.ok(fs.statSync(path.join(root, "20260912")).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
