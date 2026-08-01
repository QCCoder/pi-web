/**
 * models-store.ts
 *
 * 全局 models store（REQ-0001 决策 11「models 列表全局共享」+ 阶段 B 设计 B2）。
 *
 * /api/models?cwd= 按 cwd 枚举可用模型（project trust、enabledModels、provider auth
 * 都随 cwd 变化），所以本 store 按 cwd 分片：同一 cwd 的所有 ChatWindow 共享一份
 * 数据 + 一次请求（消除每次切 session 的重复 loadModels）。createMapStore 的 key 分片
 * 订阅保证切 cwd 时只有相关订阅者重渲染。
 *
 * 客户端 SWR（MODELS_CLIENT_TTL_MS）：近期已加载过的 cwd 直接用缓存、不发请求；
 * modelsRefreshKey 变化（编辑 models config / project trust）时 force=true 绕过 TTL。
 * 服务端另有 60s cwd 缓存（lib/models-cache.ts）；客户端 SWR 主要省的是切 session
 * 时的往返 + JSON 解析、以及让切回已访问 cwd 的模型选择器无空窗。
 */

import { useEffect, useRef } from "react";
import { createMapStore, useStoreSlice } from "./create-map-store";

export type SelectedModel = { provider: string; modelId: string };
export type ModelEntry = { id: string; name: string; provider: string };

/** /api/models 响应形状。 */
export type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  modelError?: string;
};

export interface ModelsState {
  models: Record<string, string>;
  modelList: ModelEntry[];
  modelError: string | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  defaultModel: SelectedModel | null;
  /** 最近一次成功加载的时间戳（SWR TTL 用）。 */
  loadedAt: number;
}

const EMPTY_MODELS_STATE: ModelsState = {
  models: {},
  modelList: [],
  modelError: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  defaultModel: null,
  loadedAt: 0,
};

/** 客户端 SWR TTL：此窗口内复用缓存、不发请求。models 极少变；强制刷新走 modelsRefreshKey。 */
const MODELS_CLIENT_TTL_MS = 60_000;

/** 按 cwd 分片，小 LRU（不同 cwd 数量有限，防瞬时 cwd 无界增长）。 */
export const modelsStore = createMapStore<string, ModelsState>({ maxSize: 32 });

// --- in-flight 去重 + epoch 防陈旧覆盖（同 cwd 并发复用一条；force 时新请求覆盖旧的）---
const inFlight = new Map<string, Promise<void>>();
const epochs = new Map<string, number>();

function modelsUrl(cwd: string): string {
  return cwd ? `/api/models?cwd=${encodeURIComponent(cwd)}` : "/api/models";
}

/**
 * 拉取某 cwd 的 models 并写入 store。
 * - SWR：缓存命中且未过期且非 force → 直接返回（不发请求）；
 * - 同 cwd 并发（非 force）→ 复用同一条 in-flight；
 * - force → 起一条新请求并用 epoch 覆盖（即使有旧 in-flight 也只让最新 epoch 写入）。
 */
export function fetchModels(cwd: string, opts: { force?: boolean } = {}): Promise<void> {
  const force = opts.force === true;
  const existing = modelsStore.get(cwd);
  if (existing && !force && Date.now() - existing.loadedAt < MODELS_CLIENT_TTL_MS) {
    return Promise.resolve();
  }
  if (!force) {
    const pending = inFlight.get(cwd);
    if (pending) return pending;
  }
  const epoch = (epochs.get(cwd) ?? 0) + 1;
  epochs.set(cwd, epoch);
  // 用 epoch（而非 promise 自身）做 finally 清理判定，避免闭包内引用未赋值的 promise。
  const promise: Promise<void> = (async () => {
    try {
      const res = await fetch(modelsUrl(cwd));
      if (!res.ok) return;
      const d = (await res.json()) as ModelsResponse;
      // force 起的新请求可能晚于旧 in-flight 完成；只让最新 epoch 写入，防陈旧覆盖。
      if (epochs.get(cwd) !== epoch) return;
      modelsStore.set(cwd, {
        models: d.models ?? {},
        modelList: d.modelList ?? [],
        modelError: d.modelError ?? null,
        thinkingLevels: d.thinkingLevels ?? {},
        thinkingLevelMaps: d.thinkingLevelMaps ?? {},
        defaultModel: d.defaultModel ?? null,
        loadedAt: Date.now(),
      });
    } catch {
      // 网络失败：保留缓存/默认，下次（切回 / modelsRefreshKey）再试。
    } finally {
      // 仍是最新 epoch 才清理 in-flight；被 force 取代的旧请求不动新条目。
      if (epochs.get(cwd) === epoch) inFlight.delete(cwd);
    }
  })();
  inFlight.set(cwd, promise);
  return promise;
}

/**
 * 订阅某 cwd 的 models slice 并按需拉取。
 * - cwd 变化：切到新 slice（缓存命中则无空窗），按 TTL 决定是否拉取；
 * - refreshKey 变化：force 绕过 TTL 重拉（编辑 models config / project trust 后）。
 */
export function useModels(cwd: string, refreshKey: number): ModelsState {
  const state = useStoreSlice(modelsStore, cwd, (s) => s ?? EMPTY_MODELS_STATE);
  const prevRefreshKey = useRef(refreshKey);
  useEffect(() => {
    const force = prevRefreshKey.current !== refreshKey;
    prevRefreshKey.current = refreshKey;
    void fetchModels(cwd, { force });
  }, [cwd, refreshKey]);
  return state;
}

/** 从 defaultModel + modelList 推导「新会话默认模型」（与原 loadModels 内 if(isNew) 逻辑一致）。 */
export function deriveNewSessionDefaultModel(state: ModelsState): SelectedModel | null {
  const list = state.modelList;
  const dm = state.defaultModel;
  if (dm) {
    const match = list.find((m) => m.id === dm.modelId && m.provider === dm.provider);
    const m = match ?? list[0];
    return m ? { provider: m.provider, modelId: m.id } : null;
  }
  const first = list[0];
  return first ? { provider: first.provider, modelId: first.id } : null;
}
