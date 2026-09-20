import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TEXT_PREVIEW_MAX_BYTES } = await jiti.import("./file-types.ts");
const { readTextPreviewChunk } = await jiti.import("./text-preview.ts");

test("reads large text in contiguous UTF-8 chunks", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "large.txt");
  const content = "a".repeat(TEXT_PREVIEW_MAX_BYTES - 1) + "😀tail";
  writeFileSync(filePath, content);
  const size = statSync(filePath).size;

  const first = readTextPreviewChunk(filePath, size, 0);
  const second = readTextPreviewChunk(filePath, size, first.nextOffset);

  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, TEXT_PREVIEW_MAX_BYTES - 1);
  assert.equal(second.truncated, false);
  assert.equal(first.content + second.content, content);
  assert.equal(second.nextOffset, size);
});

test("invalid UTF-8 cannot stall pagination", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "binary.txt");
  writeFileSync(filePath, Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1, 0x80));

  const chunk = readTextPreviewChunk(filePath, TEXT_PREVIEW_MAX_BYTES + 1, 0);

  assert.equal(chunk.nextOffset, TEXT_PREVIEW_MAX_BYTES);
  assert.equal(chunk.truncated, true);
});

test("pages through a 10MB file without loss or stalls", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "huge.log");
  // 10MB of deterministic ASCII with a multi-byte rune at a known position.
  const total = 10 * 1024 * 1024;
  const bytes = Buffer.alloc(total, 0x61);
  bytes.write("é", total - 8, "utf8");
  writeFileSync(filePath, bytes);
  const size = statSync(filePath).size;
  assert.ok(size >= total);

  const chunks = [];
  let offset = 0;
  let guard = 0;
  while (offset < size) {
    const chunk = readTextPreviewChunk(filePath, size, offset);
    assert.ok(chunk.content.length > 0, "every chunk carries content");
    assert.ok(chunk.nextOffset > offset, "pagination always advances");
    chunks.push(chunk);
    offset = chunk.nextOffset;
    if (++guard > 200) assert.fail("pagination did not terminate within the expected chunk budget");
  }

  const last = chunks[chunks.length - 1];
  assert.equal(last.truncated, false, "the final chunk reports completion");
  assert.equal(last.nextOffset, size);
  assert.equal(
    chunks.map((chunk) => chunk.content).join(""),
    bytes.toString("utf8"),
    "concatenated chunks reconstruct the file byte-for-byte",
  );
  let prevEnd = 0;
  for (const chunk of chunks.slice(0, -1)) {
    assert.equal(chunk.truncated, true);
    assert.ok(chunk.nextOffset - prevEnd <= TEXT_PREVIEW_MAX_BYTES, "each bounded chunk step");
    prevEnd = chunk.nextOffset;
  }
});
