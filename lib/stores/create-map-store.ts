/**
 * create-map-store.ts
 *
 * 按身份分片订阅的 Map store + React 绑定（REQ-0001 决策 4、6 的承重墙）。
 *
 * 设计目标：
 * - 按 key 分片订阅：set(k, v) 只通知订阅了 k 的组件，其余 key 的订阅者不重渲染。
 *   等价于 Proma 的 atomFamily(sessionId) 切片，但不引入 Jotai。
 * - 版本号驱动 useSyncExternalStore：getSnapshot 返回稳定数字，selector 只在该
 *   key 版本变化时运行，返回值在版本不变时引用稳定，避免无限重渲染。
 * - 可选 LRU 淘汰：传 { maxSize } 后，set 超容量时按插入顺序淘汰最旧条目，
 *   复刻 Proma 的 setSessionMessagesCache LRU 语义。
 *
 * 数据内部为可变 Map，对外通过版本号暴露变化；调用方 set 时必须传入新引用的
 * value（不可变更新），才能让下游 useMemo/useEffect 检测到字段变化。
 */

import { useCallback, useRef, useSyncExternalStore } from "react";

export interface MapStoreOptions {
  /** 启用 LRU：超过容量时按插入顺序淘汰最旧条目。 */
  maxSize?: number;
}

export interface MapStore<K, V> {
  /** 读取一个 key 的值（未设置返回 undefined）。 */
  get(key: K): V | undefined;
  /** 设置一个 key 的值。value 必须是新引用；传 undefined 等同 delete。 */
  set(key: K, value: V): void;
  /** 基于前值更新一个 key（不可变更新由 updater 负责）。 */
  update(key: K, updater: (prev: V | undefined) => V): void;
  /** 删除一个 key。 */
  delete(key: K): void;
  has(key: K): boolean;
  size(): number;
  keys(): K[];
  values(): V[];
  entries(): Array<[K, V]>;
  /** 订阅单个 key 的变化，返回取消订阅函数。 */
  subscribeKey(key: K, listener: () => void): () => void;
  /** 订阅任意变化（任意 key 增删改都触发），返回取消订阅函数。 */
  subscribe(listener: () => void): () => void;
  /** 单个 key 的版本号（每次 set/delete +1）。供 useSyncExternalStore。 */
  keyVersion(key: K): number;
  /** 全局版本号。供 useStoreEntries。 */
  version(): number;
}

export function createMapStore<K, V>(options: MapStoreOptions = {}): MapStore<K, V> {
  const data = new Map<K, V>();
  const keyVersions = new Map<K, number>();
  const keyListeners = new Map<K, Set<() => void>>();
  const allListeners = new Set<() => void>();
  let globalVersion = 0;
  const maxSize = options.maxSize;

  function bump(key: K): void {
    keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1);
    globalVersion += 1;
  }

  function notify(key: K): void {
    const ls = keyListeners.get(key);
    if (ls) {
      for (const fn of ls) fn();
    }
    for (const fn of allListeners) fn();
  }

  // LRU：超容量时淘汰插入顺序最旧的条目，并为被淘汰 key 触发版本变更，
  // 让它的订阅者感知到值已消失。
  function evictIfNeeded(): void {
    if (maxSize === undefined) return;
    while (data.size > maxSize) {
      const oldest = data.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      data.delete(oldest);
      bump(oldest);
      notify(oldest);
    }
  }

  function writeValue(key: K, value: V): void {
    // LRU：若 key 已存在，先删再 set，使其移到「最新」位置。
    if (maxSize !== undefined && data.has(key)) data.delete(key);
    data.set(key, value);
    bump(key);
    notify(key);
    evictIfNeeded();
  }

  function clearValue(key: K): void {
    if (!data.delete(key)) return;
    bump(key);
    notify(key);
  }

  return {
    get: (key) => data.get(key),
    set: (key, value) => {
      if (value === undefined) {
        clearValue(key);
        return;
      }
      writeValue(key, value);
    },
    update: (key, updater) => {
      const next = updater(data.get(key));
      if (next === undefined) {
        clearValue(key);
        return;
      }
      writeValue(key, next);
    },
    delete: clearValue,
    has: (key) => data.has(key),
    size: () => data.size,
    keys: () => Array.from(data.keys()),
    values: () => Array.from(data.values()),
    entries: () => Array.from(data.entries()),
    subscribeKey: (key, listener) => {
      let ls = keyListeners.get(key);
      if (!ls) {
        ls = new Set();
        keyListeners.set(key, ls);
      }
      ls.add(listener);
      return () => {
        ls!.delete(listener);
        if (ls!.size === 0) keyListeners.delete(key);
      };
    },
    subscribe: (listener) => {
      allListeners.add(listener);
      return () => { allListeners.delete(listener); };
    },
    keyVersion: (key) => keyVersions.get(key) ?? 0,
    version: () => globalVersion,
  };
}

/**
 * 订阅单个 key 的一个切片。selector 仅在该 key 版本变化时运行，返回值在版本
 * 不变时引用稳定。用于让组件只在自己关心的 session/workspace 变化时重渲染。
 *
 * key 变化时会重新订阅新 key（subscribe 依赖 store+key）。
 */
export function useStoreSlice<K, V, S>(
  store: MapStore<K, V>,
  key: K,
  selector: (value: V | undefined) => S,
): S {
  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribeKey(key, onStoreChange),
    [store, key],
  );
  const version = useSyncExternalStore(
    subscribe,
    () => store.keyVersion(key),
    () => 0,
  );
  // 版本号 + key 双驱动：只在版本变化 OR key 变化时才重算 selector，保证
  // 返回值引用稳定。忽略 key 变化会导致切到另一个 key 时，若两者版本号恰好
  // 相等（都很常见，比如各加载过一次都是 1），返回上一个 key 的旧 slice。
  const ref = useRef<{ key: K; version: number; slice: S } | null>(null);
  if (!isSliceCacheValid(ref.current, key, version)) {
    ref.current = { key, version, slice: selector(store.get(key)) };
  }
  return ref.current!.slice;
}

/**
 * useStoreSlice 缓存是否仍然有效。提取为纯函数以便单测：key 或 version 任一
 * 变化都必须失效——尤其是「key 变了但版本号恰好相等」这种情况（切会话时高发），
 * 否则会返回上一个 key 的旧 slice。
 */
export function isSliceCacheValid<K>(
  prev: { key: K; version: number } | null,
  key: K,
  version: number,
): boolean {
  return prev !== null && prev.key === key && prev.version === version;
}

/** 订阅整个 store 的条目列表（任意 key 增删改都触发更新）。用于列表场景。 */
export function useStoreEntries<K, V>(store: MapStore<K, V>): Array<[K, V]> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribe(onStoreChange),
    [store],
  );
  const version = useSyncExternalStore(
    subscribe,
    () => store.version(),
    () => 0,
  );
  const ref = useRef<{ version: number; entries: Array<[K, V]> } | null>(null);
  const current = ref.current;
  if (current === null || current.version !== version) {
    ref.current = { version, entries: store.entries() };
  }
  return ref.current!.entries;
}
