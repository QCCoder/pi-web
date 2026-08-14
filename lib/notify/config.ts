/** Unified per-workspace *notify* configuration (design §6, multi-channel).
 *
 *  This is the single source of truth for HOW a workspace's Work Item events are
 *  pushed out: the delivery `mode` (failover vs all) and the ordered, toggleable
 *  list of channels. It deliberately does NOT hold channel secrets — Feishu
 *  app/appSecret still lives in `lib/feishu/config.ts` (`feishu/<wsId>.json`); the
 *  WeCom group-bot webhook key is non-app-credential but still masked in the
 *  public projection. Keeping ordering/enable separate from secrets means a leak
 *  of one store never exposes another, and the UI can edit priority without
 *  touching credentials.
 *
 *  Storage: `~/.pi/agent/notify/<wsId>.json` (mode 0600), keyed by workspace id
 *  outside the workspace dir (workspaces are often git repos). */

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type NotifyMode = "failover" | "all";

/** The channels the notify layer knows how to wire. Adding a channel = add it
 *  here + a Notifier implementation + a UI entry; the dispatcher is untouched. */
export type NotifyChannelKind = "feishu" | "wecom";

export interface NotifyChannel {
  kind: NotifyChannelKind;
  enabled: boolean;
  /** Lower number = higher priority (tried first in `failover` mode; tie-break by
   *  declaration order). In `all` mode priority only affects logging order. */
  priority: number;
  /** WeCom group-bot webhook URL (`kind === "wecom"`). Stored as-is; masked in
   *  the public projection. Empty/absent => the channel self-skips at send time. */
  webhook?: string;
}

export interface NotifyConfig {
  mode: NotifyMode;
  channels: NotifyChannel[];
}

/** Safe to return to the client / UI — the webhook key is masked. */
export interface NotifyChannelPublic {
  kind: NotifyChannelKind;
  enabled: boolean;
  priority: number;
  hasWebhook: boolean;
  webhookMasked?: string;
}

export interface NotifyConfigPublic {
  mode: NotifyMode;
  channels: NotifyChannelPublic[];
}

function configFilePath(workspaceId: string): string {
  return join(getAgentDir(), "notify", `${workspaceId}.json`);
}

/** The default config when none is stored yet. WeCom starts DISABLED so a
 *  Feishu-only workspace keeps its exact current behavior (failover over a single
 *  channel == just that channel). Enable + reorder in the UI. */
export function defaultNotifyConfig(): NotifyConfig {
  return {
    mode: "failover",
    channels: [
      { kind: "feishu", enabled: true, priority: 1 },
      { kind: "wecom", enabled: false, priority: 2 },
    ],
  };
}

const VALID_MODES: NotifyMode[] = ["failover", "all"];
const VALID_KINDS: NotifyChannelKind[] = ["feishu", "wecom"];

/** Coerce a parsed object into a valid config, filling gaps with defaults. */
export function normalizeNotifyConfig(raw: unknown): NotifyConfig {
  const base = defaultNotifyConfig();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;

  const mode =
    typeof obj.mode === "string" && VALID_MODES.includes(obj.mode as NotifyMode)
      ? (obj.mode as NotifyMode)
      : base.mode;

  const seen = new Map<NotifyChannelKind, NotifyChannel>();
  // Seed with defaults so every known kind is present and toggleable in the UI.
  for (const ch of base.channels) seen.set(ch.kind, { ...ch });
  if (Array.isArray(obj.channels)) {
    for (const entry of obj.channels) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const kind = e.kind;
      if (typeof kind !== "string" || !VALID_KINDS.includes(kind as NotifyChannelKind)) continue;
      const k = kind as NotifyChannelKind;
      seen.set(k, {
        kind: k,
        enabled: e.enabled !== false,
        priority: typeof e.priority === "number" && Number.isFinite(e.priority) ? e.priority : seen.get(k)!.priority,
        webhook: typeof e.webhook === "string" && e.webhook.trim() ? e.webhook.trim() : undefined,
      });
    }
  }
  // Stable order by priority then by the known-kind declaration order.
  const orderIndex = new Map(VALID_KINDS.map((k, i) => [k, i]));
  const channels = [...seen.values()].sort(
    (a, b) => a.priority - b.priority || orderIndex.get(a.kind)! - orderIndex.get(b.kind)!,
  );
  return { mode, channels };
}

export async function readNotifyConfig(workspaceId: string): Promise<NotifyConfig> {
  try {
    const raw = await readFile(configFilePath(workspaceId), "utf8");
    return normalizeNotifyConfig(JSON.parse(raw));
  } catch {
    return defaultNotifyConfig();
  }
}

export async function writeNotifyConfig(workspaceId: string, config: NotifyConfig): Promise<void> {
  const normalized = normalizeNotifyConfig(config);
  const path = configFilePath(workspaceId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(normalized, null, 2), { mode: 0o600 });
}

export async function deleteNotifyConfig(workspaceId: string): Promise<void> {
  try {
    await unlink(configFilePath(workspaceId));
  } catch {
    /* already gone */
  }
}

/** Mask a WeCom webhook URL for safe display: keep the host, hide the key. */
export function maskWebhook(webhook: string | undefined): string | undefined {
  if (!webhook) return undefined;
  const idx = webhook.indexOf("key=");
  if (idx === -1) return `${webhook.slice(0, 24)}…`;
  const key = webhook.slice(idx + 4);
  const shown = key.length > 6 ? `${key.slice(0, 3)}…${key.slice(-3)}` : "***";
  return `${webhook.slice(0, idx + 4)}${shown}`;
}

export function toPublicNotifyConfig(config: NotifyConfig): NotifyConfigPublic {
  return {
    mode: config.mode,
    channels: config.channels.map((c) => ({
      kind: c.kind,
      enabled: c.enabled,
      priority: c.priority,
      hasWebhook: Boolean(c.webhook),
      webhookMasked: maskWebhook(c.webhook),
    })),
  };
}

/** Enabled channels ordered by priority (lowest first). Pure — the scheduler
 *  uses this to build its ordered exporter list without knowing the config shape. */
export function orderedEnabledChannels(config: NotifyConfig): NotifyChannel[] {
  return config.channels.filter((c) => c.enabled).sort((a, b) => a.priority - b.priority);
}

/** Apply a partial patch onto an existing config, preserving any field the patch
 *  omits. This is the PUT semantics: the UI POSTs the whole form, but the WeCom
 *  webhook is returned to the UI only in masked form, so an unedited webhook must
 *  round-trip without being clobbered. Rule (mirrors Feishu appSecret): an absent
 *  or empty `webhook` in the patch keeps the stored value; a non-empty one replaces. */
export function mergeNotifyConfig(existing: NotifyConfig, patch: unknown): NotifyConfig {
  const base = normalizeNotifyConfig(existing);
  if (!patch || typeof patch !== "object") return base;
  const p = patch as Record<string, unknown>;
  const mode =
    typeof p.mode === "string" && VALID_MODES.includes(p.mode as NotifyMode) ? (p.mode as NotifyMode) : base.mode;

  const byKind = new Map<NotifyChannelKind, NotifyChannel>(base.channels.map((c) => [c.kind, { ...c }]));
  if (Array.isArray(p.channels)) {
    for (const entry of p.channels) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.kind !== "string" || !VALID_KINDS.includes(e.kind as NotifyChannelKind)) continue;
      const k = e.kind as NotifyChannelKind;
      const cur = byKind.get(k) ?? ({ kind: k, enabled: false, priority: 99 } as NotifyChannel);
      const next: NotifyChannel = { ...cur, kind: k };
      if (e.enabled === true || e.enabled === false) next.enabled = e.enabled;
      if (typeof e.priority === "number" && Number.isFinite(e.priority)) next.priority = e.priority;
      if (typeof e.webhook === "string" && e.webhook.trim()) next.webhook = e.webhook.trim();
      // absent / empty webhook => preserved via the spread above
      byKind.set(k, next);
    }
  }
  const orderIndex = new Map(VALID_KINDS.map((k, i) => [k, i]));
  const channels = [...byKind.values()].sort(
    (a, b) => a.priority - b.priority || orderIndex.get(a.kind)! - orderIndex.get(b.kind)!,
  );
  return { mode, channels };
}
