import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const executions = await jiti.import("./executions.ts");

test("write + list + resolve round-trips a pending record", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-exec-"));
  const record = {
    schemaVersion: 1, runId: "sess-1", kind: "loop-round", loopName: "dev-loop",
    sessionId: "sess-1", workspacePath: ws,
    host: { pid: 1, hostname: "h" },
    startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(),
    stopResult: "interrupted-on-shutdown", needsAttention: true,
  };
  await executions.writeExecutionRecord(record);
  const pending = await executions.listPendingExecutionRecords(ws);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].loopName, "dev-loop");
  const n = await executions.resolveExecutionRecords(ws, "dev-loop", {
    stopResult: "recovered-auto", needsAttention: false,
    diagnostic: { checkedAt: new Date().toISOString() },
  });
  assert.equal(n, 1);
  assert.equal((await executions.listPendingExecutionRecords(ws)).length, 0);
  // resolve 后文件保留（审计），只是 needsAttention=false
  const raw = JSON.parse(await readFile(join(executions.executionsDir(ws), "sess-1.json"), "utf8"));
  assert.equal(raw.stopResult, "recovered-auto");
  await rm(ws, { recursive: true, force: true });
});

test("listPendingExecutionRecords skips malformed files and non-pending", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-exec-"));
  await mkdir(executions.executionsDir(ws), { recursive: true });
  await writeFile(join(executions.executionsDir(ws), "junk.json"), "{not json");
  const resolved = { schemaVersion: 1, runId: "r2", kind: "loop-round", loopName: "l2", sessionId: "r2",
    workspacePath: ws, host: { pid: 1, hostname: "h" }, startedAt: "t", stoppedAt: "t",
    stopResult: "recovered-auto", needsAttention: false };
  await executions.writeExecutionRecord(resolved);
  assert.equal((await executions.listPendingExecutionRecords(ws)).length, 0);
  await rm(ws, { recursive: true, force: true });
});

test("detectSurvivingRoundProcesses with injected fake process table", async () => {
  // detectSurvivingRoundProcesses(workspacePath, deps?) — deps 可注入 lister/cwdOf
  const pids = await executions.detectSurvivingRoundProcesses("/tmp/ws", {
    lister: () => [
      { pid: 11, ppid: 1, command: "npm run build" },
      { pid: 12, ppid: 2, command: "npm test" },
      { pid: 13, ppid: 1, command: "/usr/libexec/blah" },
    ],
    cwdOf: (pid) => (pid === 11 ? "/tmp/ws/repo" : pid === 12 ? "/tmp/ws" : "/other"),
  });
  assert.deepEqual(pids, [11]);  // 只报 ppid=1 + build/shell + cwd 命中的
});
