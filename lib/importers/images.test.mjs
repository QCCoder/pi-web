import assert from "node:assert/strict";
import test from "node:test";
import { detectImageExt, extractChandaoFileIds, rewriteChandaoImageSources } from "./images.ts";

test("extractChandaoFileIds returns unique ids in order of first appearance", () => {
  const html = `<p>see <img src="/index.php?m=file&f=read&t=png&fileID=507"> and
    <img src='/index.php?m=file&f=read&t=png&fileID=12'> then again
    <img src="/index.php?m=file&f=read&t=jpg&fileID=507"></p>`;
  assert.deepEqual(extractChandaoFileIds(html), ["507", "12"]);
});

test("extractChandaoFileIds returns empty when no images", () => {
  assert.deepEqual(extractChandaoFileIds("no images here"), []);
});

test("rewriteChandaoImageSources rewrites double-quoted src to relative path", () => {
  const html = `<img src="/index.php?m=file&f=read&t=png&fileID=507">`;
  const out = rewriteChandaoImageSources(html, () => "png");
  assert.equal(out, `<img src="attachments/chandao-507.png">`);
});

test("rewriteChandaoImageSources rewrites single-quoted src", () => {
  const html = `<img src='/index.php?m=file&f=read&t=png&fileID=9'>`;
  const out = rewriteChandaoImageSources(html, () => "jpg");
  assert.equal(out, `<img src='attachments/chandao-9.jpg'>`);
});

test("rewriteChandaoImageSources rewrites multiple images with per-id ext", () => {
  const html = `<img src="/index.php?m=file&f=read&fileID=1"><img src="/index.php?m=file&f=read&fileID=2">`;
  const out = rewriteChandaoImageSources(html, (id) => (id === "1" ? "png" : "jpg"));
  assert.equal(
    out,
    `<img src="attachments/chandao-1.png"><img src="attachments/chandao-2.jpg">`,
  );
});

test("rewriteChandaoImageSources leaves non-chandao srcs untouched", () => {
  const html = `<img src="https://example.com/foo.png"><img src="/index.php?m=file&f=read&fileID=7">`;
  const out = rewriteChandaoImageSources(html, () => "png");
  assert.equal(
    out,
    `<img src="https://example.com/foo.png"><img src="attachments/chandao-7.png">`,
  );
});

test("rewriteChandaoImageSources falls back to bin when ext unknown", () => {
  const html = `<img src="/index.php?m=file&f=read&fileID=7">`;
  const out = rewriteChandaoImageSources(html, () => "");
  assert.equal(out, `<img src="attachments/chandao-7.bin">`);
});

test("detectImageExt detects png/jpg/gif/webp from magic bytes", () => {
  assert.equal(detectImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])), "png");
  assert.equal(detectImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(detectImageExt(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39])), "gif");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
  assert.equal(detectImageExt(webp), "webp");
});

test("detectImageExt falls back to content-type then bin", () => {
  assert.equal(detectImageExt(Buffer.from([0x01, 0x02]), "image/jpeg"), "jpg");
  assert.equal(detectImageExt(Buffer.from([0x01, 0x02]), "image/png"), "png");
  assert.equal(detectImageExt(Buffer.from([0x01, 0x02])), "bin");
});
