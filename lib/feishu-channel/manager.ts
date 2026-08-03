import {
  discoverWorkspaces,
  effectiveCapabilities,
  getWorkspace,
} from "../workspaces/service.ts";
import { readFeishuConfig } from "../feishu/config.ts";
import { listBindings } from "./binding-store.ts";
import {
  FeishuLongConnection,
  type LongConnectionLogger,
} from "./long-connection.ts";
import { routeInboundDm } from "./router.ts";
import type { FeishuChannelState, FeishuChannelStatus } from "./types.ts";

/**
 * feishu-channel lifecycle manager.
 *
 * Owns one {@link FeishuLongConnection} per workspace (1 Feishu app <-> 1
 * workspace). Handles live on `globalThis` so they survive Next.js hot-reload
 * (mirrors rpc-manager's session registry). A channel is started only for a
 * workspace that has BOTH the `feishu-channel` capability AND configured Feishu
 * credentials.
 *
 * This is a service module (not an LLM-tool extension): it is never registered
 * in WORKSPACE_EXTENSION_FACTORIES. Boot wiring lives in instrumentation.ts.
 */

interface FeishuChannelHandle {
  workspaceId: string;
  workspacePath: string;
  appId: string;
  connection: FeishuLongConnection;
  state: FeishuChannelState;
  message?: string;
}

declare global {
  var __piFeishuChannels: Map<string, FeishuChannelHandle> | undefined;
}

function registry(): Map<string, FeishuChannelHandle> {
  if (!globalThis.__piFeishuChannels) {
    globalThis.__piFeishuChannels = new Map();
    const cleanup = (): void => {
      const map = globalThis.__piFeishuChannels;
      if (!map) return;
      for (const handle of map.values()) {
        void handle.connection.stop();
      }
      map.clear();
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piFeishuChannels;
}

function makeLogger(workspaceId: string): LongConnectionLogger {
  const prefix = `[feishu-channel:${workspaceId}]`;
  return {
    info: (m) => console.log(`${prefix} ${m}`),
    warn: (m) => console.warn(`${prefix} ${m}`),
    error: (m) => console.error(`${prefix} ${m}`),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function stopHandle(workspaceId: string): Promise<void> {
  const handle = registry().get(workspaceId);
  if (!handle) return;
  registry().delete(workspaceId);
  await handle.connection.stop();
}

async function startHandle(
  workspaceId: string,
  workspacePath: string,
  appId: string,
  appSecret: string,
): Promise<void> {
  await stopHandle(workspaceId); // tear down any prior handle (e.g. appId changed)
  const logger = makeLogger(workspaceId);
  const handle: FeishuChannelHandle = {
    workspaceId,
    workspacePath,
    appId,
    state: "connecting",
    connection: new FeishuLongConnection(
      appId,
      appSecret,
      {
        onDm: (dm) => routeInboundDm(dm, { workspaceId, workspacePath }),
        onStateChange: (state) => {
          handle.state = state;
        },
      },
      undefined,
      logger,
    ),
  };
  registry().set(workspaceId, handle);
  try {
    await handle.connection.start();
  } catch (err) {
    handle.message = errMsg(err);
    logger.error(`failed to start: ${errMsg(err)}`);
  }
}

/**
 * Ensure the channel is running for the workspace iff it has the capability +
 * credentials. If the capability/creds were removed, stop any running channel.
 * Idempotent; safe to call after every capability or credential change. This is
 * the single sync point the workspace PATCH and feishu config routes call.
 */
export async function ensureFeishuChannelStarted(workspaceId: string): Promise<FeishuChannelStatus> {
  const { manifest, path } = await getWorkspace(workspaceId);
  const hasCapability = effectiveCapabilities(manifest).includes("feishu-channel");
  const config = await readFeishuConfig(manifest.id);

  if (!hasCapability || !config) {
    await stopHandle(workspaceId);
    return statusSnapshot(workspaceId, "disabled");
  }

  const existing = registry().get(workspaceId);
  if (existing && existing.appId === config.appId) {
    return statusSnapshot(workspaceId, existing.state); // already running for this app
  }

  await startHandle(workspaceId, path, config.appId, config.appSecret);
  const handle = registry().get(workspaceId);
  return statusSnapshot(workspaceId, handle?.state ?? "stopped");
}

/** Stop the channel for a workspace (e.g. capability toggled off). */
export async function stopFeishuChannel(workspaceId: string): Promise<void> {
  await stopHandle(workspaceId);
}

/** Stop + start, picking up fresh credentials (called after a feishu config PUT). */
export async function restartFeishuChannel(workspaceId: string): Promise<FeishuChannelStatus> {
  await stopHandle(workspaceId);
  return ensureFeishuChannelStarted(workspaceId);
}

/** Status snapshot for the API / config UI. */
export async function getFeishuChannelStatus(workspaceId: string): Promise<FeishuChannelStatus> {
  const handle = registry().get(workspaceId);
  return statusSnapshot(workspaceId, handle?.state ?? "stopped", handle?.message);
}

async function statusSnapshot(
  workspaceId: string,
  fallbackState: FeishuChannelState,
  message?: string,
): Promise<FeishuChannelStatus> {
  const { manifest } = await getWorkspace(workspaceId);
  const hasCapability = effectiveCapabilities(manifest).includes("feishu-channel");
  const config = await readFeishuConfig(manifest.id);
  const enabled = hasCapability && !!config;
  const handle = registry().get(workspaceId);
  const bindings = await listBindings(manifest.id);

  if (!enabled) {
    return {
      state: "disabled",
      enabled: false,
      appId: config?.appId,
      hasAppSecret: Boolean(config?.appSecret),
      bindings,
    };
  }
  return {
    state: handle?.state ?? fallbackState,
    enabled: true,
    appId: config!.appId,
    hasAppSecret: true,
    ...(message ? { message } : {}),
    connectedAt: handle?.connection.connectedAtIso ?? undefined,
    lastEventAt: handle?.connection.lastEventAtIso ?? undefined,
    bindings,
  };
}

/**
 * Boot scan: start a channel for every available workspace that has the
 * feishu-channel capability. Resilient — one workspace failing never stops the
 * others. Intended to be fire-and-forget from instrumentation.ts so it does not
 * block server boot.
 */
export async function ensureAllFeishuChannelsStarted(): Promise<void> {
  let summaries;
  try {
    summaries = await discoverWorkspaces();
  } catch (err) {
    console.error("[feishu-channel] boot scan failed:", errMsg(err));
    return;
  }
  const eligible = summaries.filter(
    (summary) => summary.available && summary.capabilities.includes("feishu-channel"),
  );
  await Promise.allSettled(
    eligible.map(async (summary) => {
      try {
        await ensureFeishuChannelStarted(summary.id);
      } catch (err) {
        console.error(
          `[feishu-channel:${summary.id}] failed to start at boot:`,
          errMsg(err),
        );
      }
    }),
  );
  if (eligible.length > 0) {
    console.log(`[feishu-channel] boot scan started ${eligible.length} channel(s)`);
  }
}
