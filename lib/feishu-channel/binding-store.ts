import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ChatSessionBinding } from "./types.ts";

/**
 * chat<->session binding store for the feishu-channel module.
 *
 * Each Feishu p2p chat is bound to one long-lived pi session (1 chat <-> 1
 * session, per the locked design). Bindings are persisted under the global pi
 * agent dir (NOT the workspace dir) so they survive across workspace
 * re-imports and are never committed to a workspace git repo. Scoped per
 * workspace id because one pi-web may serve several workspaces / Feishu apps.
 */

interface BindingFile {
  schemaVersion: 1;
  bindings: ChatSessionBinding[];
}

function bindingsFilePath(workspaceId: string): string {
  return join(getAgentDir(), "feishu-channel", workspaceId, "bindings.json");
}

async function readAll(workspaceId: string): Promise<ChatSessionBinding[]> {
  try {
    const raw = await readFile(bindingsFilePath(workspaceId), "utf8");
    const parsed = JSON.parse(raw) as Partial<BindingFile>;
    if (!Array.isArray(parsed.bindings)) return [];
    return parsed.bindings;
  } catch {
    return [];
  }
}

async function writeAll(workspaceId: string, bindings: ChatSessionBinding[]): Promise<void> {
  const path = bindingsFilePath(workspaceId);
  await mkdir(dirname(path), { recursive: true });
  const file: BindingFile = { schemaVersion: 1, bindings };
  await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

/** List every chat<->session binding for the workspace. */
export async function listBindings(workspaceId: string): Promise<ChatSessionBinding[]> {
  return readAll(workspaceId);
}

/** Look up the binding for a single chat, or null if unbound. */
export async function getBinding(
  workspaceId: string,
  chatId: string,
): Promise<ChatSessionBinding | null> {
  const all = await readAll(workspaceId);
  return all.find((binding) => binding.chatId === chatId) ?? null;
}

/** Insert or replace (by chatId) a binding. */
export async function upsertBinding(
  workspaceId: string,
  binding: ChatSessionBinding,
): Promise<void> {
  const all = await readAll(workspaceId);
  const index = all.findIndex((existing) => existing.chatId === binding.chatId);
  if (index >= 0) all[index] = binding;
  else all.push(binding);
  await writeAll(workspaceId, all);
}

/** Merge a partial update into an existing binding. Returns null if unbound. */
export async function touchBinding(
  workspaceId: string,
  chatId: string,
  patch: Partial<ChatSessionBinding>,
): Promise<ChatSessionBinding | null> {
  const all = await readAll(workspaceId);
  const index = all.findIndex((binding) => binding.chatId === chatId);
  if (index < 0) return null;
  all[index] = { ...all[index], ...patch, chatId, updatedAt: new Date().toISOString() };
  await writeAll(workspaceId, all);
  return all[index];
}

/** Drop the binding for a chat (used by `/new` to force a fresh session). */
export async function removeBinding(workspaceId: string, chatId: string): Promise<void> {
  const all = await readAll(workspaceId);
  const next = all.filter((binding) => binding.chatId !== chatId);
  if (next.length === all.length) return;
  await writeAll(workspaceId, next);
}
