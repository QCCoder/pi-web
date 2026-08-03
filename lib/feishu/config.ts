import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FeishuConfig, FeishuConfigPublic } from "./types.ts";

/** Credentials are stored under the global pi agent dir (NOT the workspace dir),
 *  keyed by workspace id, because appSecret is sensitive and workspace dirs are
 *  frequently git repos. */
function configFilePath(workspaceId: string): string {
  return join(getAgentDir(), "feishu", `${workspaceId}.json`);
}

export async function readFeishuConfig(workspaceId: string): Promise<FeishuConfig | null> {
  try {
    const raw = await readFile(configFilePath(workspaceId), "utf8");
    const parsed = JSON.parse(raw) as Partial<FeishuConfig>;
    if (!parsed.appId || !parsed.appSecret) return null;
    return {
      appId: parsed.appId,
      appSecret: parsed.appSecret,
      receiveIdType: parsed.receiveIdType ?? "open_id",
      receiveId: parsed.receiveId ?? "",
    };
  } catch {
    return null;
  }
}

export async function writeFeishuConfig(
  workspaceId: string,
  config: FeishuConfig,
): Promise<void> {
  const path = configFilePath(workspaceId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Project the config into a shape safe to return to the client / UI. */
export function toPublicConfig(config: FeishuConfig | null): FeishuConfigPublic | null {
  if (!config) return null;
  return {
    appId: config.appId,
    hasAppSecret: Boolean(config.appSecret),
    receiveIdType: config.receiveIdType,
    receiveId: config.receiveId,
  };
}
