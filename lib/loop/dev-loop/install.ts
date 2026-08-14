/** Install the dev Loop definition from a shipped static template (design
 *  §7 / redesign Phase G). This replaces the old generator pair
 *  (contract.ts + authoring.ts): the dev Loop is now a *user* of the engine, and
 *  its entire behavior ships as static files under `./template/` — zero project
 *  facts hardcoded. This module only does file I/O (deep seam): copy the
 *  template into `<workspace>/loops/dev-loop/`, fail on conflict, rollback on
 *  error, then let the generic engine read it back via `readLoopDefinition`.
 *
 *  The template directory is resolved relative to this file via `import.meta.url`
 *  so it works under both node:test (jiti) and the Next server. */

import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { LoopConflictError, readLoopDefinition } from "../store.ts";
import type { LoopDefinition, WorkspaceLocation } from "../types.ts";

export const DEV_LOOP_ID = "dev-loop";

/** Resolved path to the shipped static template directory. */
const TEMPLATE_DIR = fileURLToPath(new URL("./template", import.meta.url));

export interface DevLoopDefinitionResult {
  definition: LoopDefinition;
  created: boolean;
}

/** Ensure the dev Loop exists for a workspace, creating it from the template if
 *  absent. Idempotent: returns the existing definition (created:false) if it is
 *  already readable, so the API and any boot-time guard can call it freely. */
export async function ensureDevLoopDefinition(
  workspace: WorkspaceLocation,
): Promise<DevLoopDefinitionResult> {
  try {
    const existing = await readLoopDefinition(workspace, DEV_LOOP_ID);
    return { definition: existing, created: false };
  } catch {
    // Not found (or unreadable half-written dir) -> (re)create from template.
  }
  const definition = await copyTemplate(workspace);
  return { definition, created: true };
}

/** Create the dev Loop definition; throws LoopConflictError if it already
 *  exists (readably). */
export async function createDevLoopDefinition(
  workspace: WorkspaceLocation,
): Promise<LoopDefinition> {
  let exists = false;
  try {
    await readLoopDefinition(workspace, DEV_LOOP_ID);
    exists = true;
  } catch {
    // not found (or unreadable) -> proceed to create
  }
  if (exists) throw new LoopConflictError(`dev-loop already exists for ${workspace.id}`);
  return copyTemplate(workspace);
}

/** Copy the shipped template into `<workspace>/loops/dev-loop/`. Uses
 *  `errorOnExist` + `force:false` so it never silently overwrites (mirrors the
 *  flag:wx guarantee of the generic authoring path); rolls the target directory
 *  back on any error. */
async function copyTemplate(workspace: WorkspaceLocation): Promise<LoopDefinition> {
  const directory = resolve(workspace.path, "loops", DEV_LOOP_ID);
  try {
    await mkdir(resolve(workspace.path, "loops"), { recursive: true });
    await cp(TEMPLATE_DIR, directory, { recursive: true, force: false, errorOnExist: true });
  } catch (error) {
    // Rollback only what we created. If the directory pre-existed and was
    // unreadable (readLoopDefinition threw), removing it is the desired cleanup;
    // if cp created nothing, rm is a no-op.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return readLoopDefinition(workspace, DEV_LOOP_ID);
}
