/**
 * file-resource-cache.ts
 *
 * 文件资源缓存：目录列表 + 文件内容的内存 LRU（REQ-0001 决策 6、10）。
 *
 * 目的：切走再切回已浏览的目录/文件时不重新 fetch；agent 写文件时按路径
 * 精确失效对应目录与文件内容，避免全局 refreshKey 导致所有目录重读。
 *
 * 目录条目以 unknown[] 存储（FileExplorer 等消费方各自 cast 到本地 FileEntry
 * 类型），使本模块不依赖具体 UI 类型。key 为目录绝对路径——目录列表只取决于
 * 文件系统真实内容，与 workspace 无关，故不需要 workspaceId 入 key。
 *
 * 失效策略（决策 10）：
 * - agent 写文件 → invalidatePath(absolutePath)：失效该文件所在目录 + 该文件内容
 * - 手动刷新 → invalidateDirectory(dirPath) 或按 workspace 前缀批量失效
 * - 外部编辑器修改：web 无法检测，靠消费方访问时的 TTL 兜底（本模块不强制 TTL）
 */

import { createMapStore, type MapStore } from "./create-map-store";

export const DIRECTORY_CACHE_MAX = 50;
export const FILE_CONTENT_CACHE_MAX = 100;

export type ResourceStatus = "idle" | "loading" | "ready" | "error";

export interface DirectoryCacheEntry {
  /** 目录条目（消费方 cast 到本地类型，如 FileExplorer 的 FileEntry）。 */
  entries: unknown[];
  status: ResourceStatus;
  loadedAt: number;
  /** 失效标记：置 true 后下次访问应重新拉取（SWR：先用旧值再后台刷新）。 */
  invalidated: boolean;
}

export interface FileContentCacheEntry {
  content: string;
  modifiedAt: number;
  size: number;
  /** 无法作为文本展示的二进制文件。 */
  binary?: boolean;
}

export const directoryCache: MapStore<string, DirectoryCacheEntry> =
  createMapStore<string, DirectoryCacheEntry>({ maxSize: DIRECTORY_CACHE_MAX });

export const fileContentCache: MapStore<string, FileContentCacheEntry> =
  createMapStore<string, FileContentCacheEntry>({ maxSize: FILE_CONTENT_CACHE_MAX });

/** 读取目录缓存条目（未命中返回 undefined）。 */
export function getDirectoryCache(dirPath: string): DirectoryCacheEntry | undefined {
  return directoryCache.get(dirPath);
}

/** 写入目录缓存条目（重置 invalidated）。 */
export function setDirectoryCache(dirPath: string, entries: unknown[], status: ResourceStatus = "ready"): void {
  directoryCache.set(dirPath, { entries, status, loadedAt: Date.now(), invalidated: false });
}

/** 标记单个目录失效（下次访问重新拉取，但不立即清除旧值——SWR）。 */
export function invalidateDirectory(dirPath: string): void {
  const entry = directoryCache.get(dirPath);
  if (!entry) return;
  directoryCache.set(dirPath, { ...entry, invalidated: true });
}

/** 失效一个文件路径：其所在目录 + 该文件的内容缓存。用于 agent 写文件后。 */
export function invalidatePath(absolutePath: string): void {
  // 失效文件内容
  fileContentCache.delete(absolutePath);
  // 失效所在目录（取到最后一个分隔符之前）
  const sep = absolutePath.includes("\\") && !absolutePath.includes("/") ? "\\" : "/";
  const idx = absolutePath.lastIndexOf(sep);
  if (idx > 0) {
    const dir = absolutePath.slice(0, idx);
    invalidateDirectory(dir);
  }
}

/** 失效某 workspace 路径前缀下的所有缓存目录（手动刷新按钮）。 */
export function invalidateUnderPrefix(prefix: string): void {
  const normalized = prefix.replace(/[/\\]+$/, "");
  const sep = normalized.includes("\\") && !normalized.includes("/") ? "\\" : "/";
  const base = normalized + sep;
  for (const key of directoryCache.keys()) {
    if (key === normalized || key.startsWith(base)) {
      invalidateDirectory(key);
    }
  }
}

/** 读取文件内容缓存。 */
export function getFileContentCache(filePath: string): FileContentCacheEntry | undefined {
  return fileContentCache.get(filePath);
}

/** 写入文件内容缓存。 */
export function setFileContentCache(filePath: string, entry: FileContentCacheEntry): void {
  fileContentCache.set(filePath, entry);
}

/** 清除文件内容缓存（文件被删除/重命名时）。 */
export function dropFileContentCache(filePath: string): void {
  fileContentCache.delete(filePath);
}
