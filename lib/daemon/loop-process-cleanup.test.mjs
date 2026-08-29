import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parsePgrepChildren,
  parseLsofCwd,
  parsePsRows,
  isCwdInWorkspace,
  isBuildOrShellCommand,
} = await jiti.import("./loop-process-cleanup.ts");

test("parsePgrepChildren: parses one pid per line, ignores junk", () => {
  assert.deepEqual(parsePgrepChildren("123\n456\n\n789\n"), [123, 456, 789]);
  assert.deepEqual(parsePgrepChildren("not-a-pid\n12x3\n"), []);
  assert.deepEqual(parsePgrepChildren(""), []);
});

test("parseLsofCwd: pulls the n<path> line", () => {
  const out = ["p42530", "fcwd", "n/Users/x/ws/repositories/code/repo", ""].join("\n");
  assert.equal(parseLsofCwd(out), "/Users/x/ws/repositories/code/repo");
  assert.equal(parseLsofCwd("p1\nf txt\n"), undefined);
});

test("parsePsRows: skips the header, parses pid/ppid/command", () => {
  const out = [
    "  PID  PPID COMMAND",
    "    1     0 /sbin/launchd",
    "42530     1 npm",
    "43388 42530 node /path/to/npm-cli.js install",
  ].join("\n");
  const rows = parsePsRows(out);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { pid: 1, ppid: 0, command: "/sbin/launchd" });
  assert.equal(rows[1].pid, 42530);
  assert.equal(rows[1].ppid, 1);
  assert.equal(rows[1].command, "npm");
  assert.equal(rows[2].pid, 43388);
  assert.match(rows[2].command, /npm-cli\.js install/);
});

test("parsePsRows: header row with non-numeric PID is dropped", () => {
  const rows = parsePsRows("  PID  PPID COMMAND\n");
  assert.deepEqual(rows, []);
});

test("isCwdInWorkspace: exact match or subdir, path-boundary aware", () => {
  const ws = "/Users/x/.pi/workspaces/workspace-c";
  assert.equal(isCwdInWorkspace(ws, ws), true);
  assert.equal(
    isCwdInWorkspace(`${ws}/repositories/cargoware-h5/worktrees/br`, ws),
    true,
  );
  // sibling that shares a prefix must NOT match
  assert.equal(isCwdInWorkspace("/Users/x/.pi/workspaces/workspace-cx", ws), false);
  assert.equal(isCwdInWorkspace(undefined, ws), false);
  assert.equal(isCwdInWorkspace("/tmp", ws), false);
});

test("isBuildOrShellCommand: matches first-token basename of known binaries", () => {
  assert.equal(isBuildOrShellCommand("npm"), true);
  assert.equal(isBuildOrShellCommand("npm install skywalking-client-js"), true);
  assert.equal(isBuildOrShellCommand("/usr/local/bin/node /path/npm-cli.js"), true);
  assert.equal(isBuildOrShellCommand("bash -c 'cd x && npm i'"), true);
  assert.equal(isBuildOrShellCommand("mvn -pl mod test"), true);
  // unknown / daemon-like commands are filtered out (perf pre-filter only)
  assert.equal(isBuildOrShellCommand("/sbin/launchd"), false);
  assert.equal(isBuildOrShellCommand("com.apple.WebKit"), false);
  assert.equal(isBuildOrShellCommand(""), false);
});
