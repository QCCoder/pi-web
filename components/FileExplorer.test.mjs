import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("refresh invalidates the whole cached subtree under cwd, not just the root", () => {
  // 旧行为只 invalidateDirectory(cwd)：已展开的子目录在 refreshToken 变化时
  // 依旧命中旧缓存（fetchEntries 的缓存命中分支），删除/改名的文件一直挂
  // 在树上。刷新必须失效 cwd 前缀下的全部缓存目录，展开的子目录才会重拉。
  assert.match(source, /invalidateUnderPrefix\(cwd\)/);
  // 上传的精确失效路径保留（只失效上传目标目录）。
  assert.match(source, /invalidateDirectory\(target\)/);
});
