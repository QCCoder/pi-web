/** Author the dev Loop definition on disk (design §7 / §13). This is the deep
 *  seam that hides "write loop.yaml + LOOP.md + STATE.md + agents/{developer,
 *  tester}.md + audit/ + LEARN.jsonl" behind one entry. The contract content comes
 *  from the pure renderers in contract.ts; this module only does file I/O.
 *
 *  Mirrors lib/loop/authoring.ts createLoopDefinition (flag:wx + rollback on
 *  error) but writes a fixed, data-driven dev-loop contract instead of the generic
 *  form. The generic engine reads it back via readLoopDefinition — the dev Loop is
 *  a *user* of the engine, not engine code. */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { LoopConflictError, readLoopDefinition } from "../store.ts";
import {
  DEV_LOOP_ID,
  renderDeveloperAgent,
  renderDevLoopInstructions,
  renderDevLoopState,
  renderTesterAgent,
} from "./contract.ts";
import type { LoopDefinition, WorkspaceLocation } from "../types.ts";

/** Cron: weekdays 09:00 Asia/Shanghai (design §7.1). */
const DEV_LOOP_CRON = "0 9 * * 1-5";
const DEV_LOOP_TIMEZONE = "Asia/Shanghai";

export interface DevLoopDefinitionResult {
  definition: LoopDefinition;
  created: boolean;
}

/** Create the dev Loop definition for a workspace. Idempotent: returns the
 *  existing definition (created:false) if it is already present, so the API and
 *  the boot-time guard can call it freely. Throws LoopConflictError only if a
 *  non-dev-loop loop somehow occupies the directory. */
export async function ensureDevLoopDefinition(
  workspace: WorkspaceLocation,
): Promise<DevLoopDefinitionResult> {
  try {
    const existing = await readLoopDefinition(workspace, DEV_LOOP_ID);
    return { definition: existing, created: false };
  } catch {
    // Not found (or invalid half-written dir) -> (re)create below.
  }
  const definition = await writeDevLoopFiles(workspace);
  return { definition, created: true };
}

/** Create the dev Loop definition; throws LoopConflictError if it already exists. */
export async function createDevLoopDefinition(
  workspace: WorkspaceLocation,
): Promise<LoopDefinition> {
  let exists = false;
  try {
    await readLoopDefinition(workspace, DEV_LOOP_ID);
    exists = true;
  } catch {
    // not found (or invalid half-written dir) -> proceed to create
  }
  if (exists) throw new LoopConflictError(`dev-loop already exists for ${workspace.id}`);
  return writeDevLoopFiles(workspace);
}

async function writeDevLoopFiles(workspace: WorkspaceLocation): Promise<LoopDefinition> {
  const loopsRoot = resolve(workspace.path, "loops");
  const directory = resolve(loopsRoot, DEV_LOOP_ID);
  await mkdir(loopsRoot, { recursive: true });

  const yaml = stringify(
    {
      schema_version: 1,
      id: DEV_LOOP_ID,
      name: "研发 Loop（自主研发闭环）",
      description:
        "自主选品 -> 三重判定(信心×验证×风险) -> TDD maker/checker -> 分支/PR -> gate -> learn. 唯一会进化的 Loop。",
      enabled: true,
      autonomy: "L2",
      triggers: [
        { id: "weekday-morning", type: "cron", expression: DEV_LOOP_CRON, timezone: DEV_LOOP_TIMEZONE, enabled: true },
        { id: "run-now", type: "manual", enabled: true },
      ],
    },
    { lineWidth: 0 },
  );

  const files: Array<[string, string]> = [
    [join(directory, "loop.yaml"), yaml],
    [join(directory, "LOOP.md"), renderDevLoopInstructions()],
    [join(directory, "STATE.md"), renderDevLoopState()],
    [join(directory, "agents", "developer.md"), renderDeveloperAgent()],
    [join(directory, "agents", "tester.md"), renderTesterAgent()],
    [join(directory, "LEARN.jsonl"), ""],
  ];

  try {
    await mkdir(join(directory, "agents"), { recursive: true });
    await mkdir(join(directory, "audit"), { recursive: true });
    await Promise.all(files.map(([path, content]) => writeFile(path, content, { encoding: "utf8", flag: "wx" })));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return readLoopDefinition(workspace, DEV_LOOP_ID);
}
