import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ChandaoConfigPublic,
  ImporterConfig,
  ImporterConfigPublic,
} from "./types.ts";

/** Importer credentials are stored under the global pi agent dir (NOT the
 *  workspace dir), keyed by workspace id — because workspace dirs are
 *  frequently git repos and the password is sensitive. */
function configFilePath(workspaceId: string): string {
  return join(getAgentDir(), "importers", `${workspaceId}.json`);
}

export async function readImporterConfig(workspaceId: string): Promise<ImporterConfig | null> {
  try {
    const raw = await readFile(configFilePath(workspaceId), "utf8");
    const parsed = JSON.parse(raw) as Partial<ImporterConfig>;
    const chandao = parsed.chandao;
    if (!chandao || !chandao.base || !chandao.account || !chandao.password) return null;
    return {
      chandao: {
        base: chandao.base,
        account: chandao.account,
        password: chandao.password,
        ...(chandao.token ? { token: chandao.token } : {}),
        assignee: chandao.assignee ?? chandao.account,
        productId: Number(chandao.productId),
        executionId: Number(chandao.executionId),
      },
    };
  } catch {
    return null;
  }
}

export async function writeImporterConfig(
  workspaceId: string,
  config: ImporterConfig,
): Promise<void> {
  const path = configFilePath(workspaceId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Project the config into a shape safe to return to the client / UI. */
export function toPublicConfig(config: ImporterConfig | null): ImporterConfigPublic | null {
  if (!config?.chandao) return null;
  const chandao = config.chandao;
  const pub: ChandaoConfigPublic = {
    base: chandao.base,
    account: chandao.account,
    hasPassword: Boolean(chandao.password),
    hasToken: Boolean(chandao.token),
    assignee: chandao.assignee,
    productId: chandao.productId,
    executionId: chandao.executionId,
  };
  return { chandao: pub };
}
