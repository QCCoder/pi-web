#!/usr/bin/env node
// Real-machine verification for the Chandao Importer (P0+P1 self-check).
// Run with the chandao password in the environment:
//   CHANDAO_PASSWORD='…' node scripts/verify-chandao-importer.mjs
// If the password is absent it prints instructions and exits without touching
// the network. Operates on the real cxin workspace (~/.pi/workspaces/workspace-c).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChandaoImporter } from "../lib/importers/chandao-importer.ts";
import { readImporterConfig, writeImporterConfig } from "../lib/importers/config.ts";
import { syncImporterForWorkspace } from "../lib/importers/runner.ts";
import { getWorkspace, updateWorkspace } from "../lib/workspaces/service.ts";
import { readWorkItem } from "../lib/work-items/service.ts";

const WS_ID = "01KYRBBY917PW4X0VHMY5GC8TE";
const CHANDAO_BASE = "https://chandao.hi-strong.com";
const ACCOUNT = "qiancheng";
const ASSIGNEE = "qiancheng";
const PRODUCT_ID = 2;
const EXECUTION_ID = 3;

const password = process.env.CHANDAO_PASSWORD;
if (!password) {
  console.log("ℹ CHANDAO_PASSWORD not set. Provide it to run the real-machine verification:");
  console.log("    CHANDAO_PASSWORD='your-password' node scripts/verify-chandao-importer.mjs");
  process.exit(0);
}

// 0. Enable the capability on cxin (idempotent) + write credentials.
const { manifest } = await getWorkspace(WS_ID);
const capabilities = [...new Set([...(manifest.capabilities ?? []), "requirement-sources"])];
await updateWorkspace(WS_ID, { capabilities });
console.log(`✓ requirement-sources enabled on ${manifest.name} (${manifest.slug})`);
await writeImporterConfig(WS_ID, {
  chandao: { base: CHANDAO_BASE, account: ACCOUNT, password, assignee: ASSIGNEE, productId: PRODUCT_ID, executionId: EXECUTION_ID },
});
console.log("✓ importer credentials written (0600)");

const cfg = (await readImporterConfig(WS_ID)).chandao;
const importer = new ChandaoImporter(cfg);

// 1. listAssigned
const items = await importer.listAssigned();
const bugs = items.filter((i) => i.kind === "bug");
const tasks = items.filter((i) => i.kind === "task");
console.log(`✓ listAssigned: ${bugs.length} bugs, ${tasks.length} tasks`);
console.log("  bugs:", bugs.map((b) => `${b.sourceId}:${b.title}`));
console.log("  tasks:", tasks.map((t) => `${t.sourceId}:${t.title}`));

// 2. getDetail(50) steps contain <img>
const detail50 = await importer.getDetail("50");
console.log(`✓ getDetail(50): title="${detail50.title}", body has <img>=${/fileID=/.test(detail50.body)}`);

// 3. getAttachment(507) PNG magic bytes
const att = await importer.getAttachment("507");
assert.equal(att.bytes[0], 0x89, "attachment 507 should start with PNG magic 0x89");
assert.equal(att.bytes[1], 0x50, "attachment 507 byte 1 should be 'P'");
console.log(`✓ getAttachment(507): ext=${att.ext}, ${att.bytes.length} bytes, PNG magic OK`);

// 4. Real sync into cxin + idempotent re-run.
const first = await syncImporterForWorkspace(WS_ID);
console.log(`✓ sync #1: +${first.created} created, ${first.synced} synced, ${first.skipped} skipped, ${first.errors} errors`);
for (const d of first.details) console.log(`    ${d.action} ${d.kind} ${d.sourceId} -> ${d.key ?? d.error}`);

if (first.created > 0) {
  const createdDetail = first.details.find((d) => d.action === "created");
  if (createdDetail?.key) {
    const wi = await readWorkItem((await getWorkspace(WS_ID)).path, createdDetail.key);
    console.log(`✓ work item ${createdDetail.key}: external.sourceId=${wi.item.external?.sourceId}, README has localized img=${/attachments\/chandao-\d+\./.test(wi.content)}`);
  }
}

const second = await syncImporterForWorkspace(WS_ID);
console.log(`✓ sync #2 (idempotent): +${second.created} created, ${second.synced} synced`);
assert.equal(second.created, 0, "second sync must not create duplicates");
console.log("\n✅ ALL CHECKS PASSED");
