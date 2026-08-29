/**
 * global-agent-events.ts
 *
 * 全局 SSE 管理器（REQ-0001 决策 8 / 阶段 B4b）。AppShell 单实例。为每个 running
 * session 维护一条 /api/agent/[id]/events，事件经 applyAgentEvent 写 SessionRuntimeStore
 * + SessionMessagesCache（按 sessionId 分片）——切走运行中的 session 事件不丢。
 *
 * - session-scoped effects（reloadSession / refreshAgentState）对所有 session 执行，
 *   保持后台缓存新鲜；
 * - UI effects（notice / extensionDialog / 完成音 / editor 注入 / finishPromptWithoutStream）
 *   只送给当前 active session（hook 注册的 handlers），后台 session 不弹阻塞 UI / 不放声。
 *
 * running id 集合由 useGlobalAgentEvents(runningIds) 驱动（复用 useSessionActivity）。
 */

import { applyAgentEvent, type AgentEventEffect } from "@/lib/agent/agent-event-reducer";
import { ensureSessionRuntime, sessionRuntimeStore, setSessionRuntime, type SessionRuntimeState } from "@/lib/stores/session-runtime-store";
import { getCachedSession, setCachedSession, updateCachedSessionData, makeMinimalSessionData } from "@/lib/stores/session-messages-cache";
import { normalizeQueuedMessages } from "@/lib/agent/agent-event-helpers";
import { type AgentEvent, type AgentStateResponse, type ExtensionUiCustomRequest, type ExtensionUiDialogRequest } from "@/lib/agent/agent-types";
import type { SessionData } from "@/hooks/useAgentSession";

const CONNECT_TIMEOUT_MS = 5_000;

export interface ActiveSessionHandlers {
  onAgentEnd?: () => void;
  addNotice?: (notice: { id?: string; message: string; type: "info" | "success" | "warning" | "error" }) => void;
  setExtensionDialog?: (request: ExtensionUiDialogRequest | null) => void;
  /** custom UI 请求带 closed 时需与当前状态合并（由调用方实现）。 */
  resolveExtensionCustomUi?: (request: ExtensionUiCustomRequest) => void;
  editorInsertText?: (text: string) => void;
  finishPromptWithoutStream?: (sid: string) => void;
}

export type GlobalConnectStatus = "connected" | "timeout" | "closed";

class GlobalAgentEventManager {
  private sources = new Map<string, EventSource>();
  private running = new Set<string>();
  /** 观看中的「活而不 running」会话（主要是 gate 暂停中的 kit 轮会话）。
   *  它们不在任何 running 集里（当前运行的定义是 prompt 在跑），但 resume 后的
   *  agent_start 要从已连接的事件流直播到达 —— pin 住现看现保，不受
   *  syncRunningIds 拆线影响，fatal 断开后重探 daemon 是否仍持有两决定重连。 */
  private pinned = new Set<string>();
  private activeSid: string | null = null;
  private active: ActiveSessionHandlers | null = null;

  /** hook 注册当前 active session 的 UI effect handlers（切换时重新注册）。 */
  setActive(sid: string | null, handlers: ActiveSessionHandlers | null): void {
    this.activeSid = sid;
    this.active = handlers;
  }

  /** 由 useGlobalAgentEvents(runningIds) 驱动：新 running id 连上，停止的断开。 */
  syncRunningIds(ids: string[]): void {
    const next = new Set(ids);
    this.running = next;
    for (const id of next) {
      if (!this.sources.has(id)) void this.ensureConnected(id);
    }
    for (const id of this.sources.keys()) {
      if (!next.has(id) && !this.pinned.has(id)) this.disconnect(id);
    }
  }

  /** Pin 一个「活而不 running」的被观看会话：立即连上事件流，且不受 running
   *  集驱动的拆除影响。观看期间一直保持 —— 包括 gate 暂停期间（resume 后
   *  agent_start 直接从这条流到达）。 */
  pinSession(sid: string): void {
    this.pinned.add(sid);
    void this.ensureConnected(sid);
  }

  /** 解除 pin。会话已不在 running 集里时连带断开事件流。 */
  unpinSession(sid: string): void {
    this.pinned.delete(sid);
    if (!this.running.has(sid)) this.disconnect(sid);
  }

  disconnect(sid: string): void {
    const es = this.sources.get(sid);
    if (es) {
      es.close();
      this.sources.delete(sid);
    }
  }

  /** 确保某 session 的 SSE 已连上（handleSend 发 prompt 前调用，防漏 agent_start）。
   *  复刻原 connectEvents：open EventSource，"connected" 事件 resolve，5s 超时；
   *  fatal(readyState CLOSED) 时若仍 running 则 1s 后重连。 */
  ensureConnected(sid: string): Promise<GlobalConnectStatus> {
    const existing = this.sources.get(sid);
    if (existing && existing.readyState === EventSource.OPEN) return Promise.resolve("connected");
    if (existing) existing.close();
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    this.sources.set(sid, es);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (status: GlobalConnectStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(status);
      };
      const timer = setTimeout(() => settle("timeout"), CONNECT_TIMEOUT_MS);
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "connected") settle("connected");
          this.onMessage(sid, event);
        } catch {
          // ignore malformed frame
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          settle("closed");
          // fatal：若仍在 running，1s 后重连（复刻原 onerror 重连）。
          if (this.sources.get(sid) === es) {
            this.sources.delete(sid);
            if (this.running.has(sid)) {
              setTimeout(() => {
                if (this.running.has(sid)) void this.ensureConnected(sid);
              }, 1000);
            } else if (this.pinned.has(sid)) {
              // pinned 会话不在 running 集里，无法从本集合区分「daemon 暂时
              // 不可达」和「会话已终销」。重探 state 路由：daemon 仍持有才重连，
              // 否则解除 pin，避免对已结束的会话无限重试。
              void this.reprobePinned(sid);
            }
          }
        }
        // recoverable (CONNECTING)：EventSource 自动重连。
      };
    });
  }

  /** pinned 会话 fatal 断开后的持有重探（见 onerror 注释）。daemon 忙可能让
   *  probe 超时，非确定性失败（网络/5xx）重试几次再放弃；daemon 明确回答
   *  「不持有」才立即解除 pin。 */
  private async reprobePinned(sid: string, attempt = 0): Promise<void> {
    let data: { loopOwned?: boolean } | null = null;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json() as { loopOwned?: boolean };
    } catch {
      // 探测本身失败（daemon 忙/网络抖动）：重试几次，仍失败才解除 pin。
      if (attempt >= 2) {
        this.unpinSession(sid);
        return;
      }
      setTimeout(() => {
        if (this.pinned.has(sid)) void this.reprobePinned(sid, attempt + 1);
      }, 1000);
      return;
    }
    if (data?.loopOwned) {
      setTimeout(() => {
        if (this.pinned.has(sid)) void this.ensureConnected(sid);
      }, 1000);
    } else {
      // daemon 明确回答不再持有该会话（终销/归档）：解除 pin，连带断开。
      this.unpinSession(sid);
    }
  }

  private onMessage(sid: string, event: AgentEvent): void {
    const prev = ensureSessionRuntime(sid);
    const messages = getCachedSession(sid)?.data.context.messages ?? [];
    const result = applyAgentEvent(prev, event, { sessionId: sid, messages });
    if (result.runtime !== prev) {
      sessionRuntimeStore.set(sid, result.runtime);
    }
    if (result.messages) {
      const next = result.messages;
      // A session that was never loadSession'd (brand-new: created via
      // /api/agent/new and streamed straight away) has no cache entry yet —
      // updateCachedSessionData would no-op and the streamed message_end
      // appends would be lost. Seed a minimal entry so live messages stick.
      if (!getCachedSession(sid)) {
        setCachedSession(sid, makeMinimalSessionData(next), undefined);
      } else {
        updateCachedSessionData(sid, (sd) => ({ ...sd, context: { ...sd.context, messages: next } }));
      }
    }
    for (const effect of result.effects) this.runEffect(sid, effect);
  }

  private runEffect(sid: string, effect: AgentEventEffect): void {
    const isActive = sid === this.activeSid;
    switch (effect.kind) {
      case "reloadSession":
        // session-scoped：保持所有 session 缓存新鲜（切回即最新）。
        this.reloadSession(sid);
        break;
      case "refreshAgentState":
        this.refreshAgentState(sid);
        break;
      case "onAgentEnd":
        if (isActive) this.active?.onAgentEnd?.();
        break;
      case "finishPromptWithoutStream":
        // slash 命令的 prompt_done：仅 active（命令从 active 发出）。
        if (isActive) this.active?.finishPromptWithoutStream?.(sid);
        break;
      case "addNotice":
        if (isActive) this.active?.addNotice?.({ id: effect.id, message: effect.message, type: effect.type });
        break;
      case "setExtensionDialog":
        if (isActive) this.active?.setExtensionDialog?.(effect.request);
        break;
      case "resolveExtensionCustomUi":
        if (isActive) this.active?.resolveExtensionCustomUi?.(effect.request);
        break;
      case "setDocumentTitle":
        if (isActive && effect.title) document.title = effect.title;
        break;
      case "editorInsertText":
        if (isActive) this.active?.editorInsertText?.(effect.text);
        break;
    }
  }

  /** agent_end / compaction_end 后重拉 session 详情（带 ETag，304 则复用缓存）。 */
  private reloadSession(sid: string): void {
    const cached = getCachedSession(sid);
    const headers: Record<string, string> = {};
    if (cached?.revision) headers["If-None-Match"] = cached.revision;
    fetch(`/api/sessions/${encodeURIComponent(sid)}?deferThinking=1&deferMedia=1`, { headers })
      .then(async (res) => {
        if (!res.ok || res.status === 304) return;
        const revision = res.headers.get("etag") ?? undefined;
        const d = (await res.json()) as SessionData;
        setCachedSession(sid, d, revision);
      })
      .catch(() => {
        // 网络失败：保留缓存，下次再试。
      });
  }

  /** agent_end 后刷新 contextUsage / systemPrompt / extensionStatuses / Widgets / queuedMessages（写 store slice）。 */
  private refreshAgentState(sid: string): void {
    fetch(`/api/agent/${encodeURIComponent(sid)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { state?: AgentStateResponse } | null) => {
        if (!data?.state) return;
        const s = data.state;
        const patch: Partial<SessionRuntimeState> = {};
        if (s.contextUsage !== undefined) patch.contextUsage = s.contextUsage ?? null;
        if (s.systemPrompt !== undefined) patch.systemPrompt = s.systemPrompt ?? null;
        if (s.extensionStatuses !== undefined) patch.extensionStatuses = s.extensionStatuses ?? [];
        if (s.extensionWidgets !== undefined) patch.extensionWidgets = s.extensionWidgets ?? [];
        if (s.queuedMessages !== undefined) patch.queuedMessages = normalizeQueuedMessages(s.queuedMessages);
        if (Object.keys(patch).length > 0) setSessionRuntime(sid, patch);
      })
      .catch(() => {
        // best-effort
      });
  }
}

/** 单例。AppShell 的 useGlobalAgentEvents 驱动；useAgentSession 注册 active handlers。 */
export const globalAgentEvents = new GlobalAgentEventManager();
