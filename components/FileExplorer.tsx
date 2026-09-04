"use client";

import { forwardRef, useState, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import {
  encodeFilePathForApi,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus } from "@/lib/git-types";
import { GitStatusBadge, type OpenFileOptions } from "./git-ui";
import { getDirectoryCache, setDirectoryCache, invalidateDirectory } from "@/lib/stores/file-resource-cache";
import { useI18n } from "@/hooks/useI18n";
type Translate = ReturnType<typeof useI18n>["t"];

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  onUploadTargetChange?: (relativePath: string) => void;
  /** Loops 面板定位用：把 reveal.path（相对 cwd 的目录路径，如 `loops/dev-loop`）的全部
   *  祖先目录（含目标本身）一次性展开；nonce 变化即可对同一路径重复触发。 */
  reveal?: { path: string; nonce: number };
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  target: string;
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  target: string;
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

function mapFileEntries(entries: FileEntry[], dirPath: string): FileNode[] {
  return entries.map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  // REQ-0001 决策 6/10：命中且未失效的目录缓存直接复用，免重新 fetch。
  // 缓存存原始 FileEntry[]，每次 map 成新 FileNode[]，避免展开时 mutate children 污染缓存。
  const cached = getDirectoryCache(dirPath);
  if (cached && !cached.invalidated) {
    return mapFileEntries(cached.entries as FileEntry[], dirPath);
  }
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  const entries = data.entries ?? [];
  setDirectoryCache(dirPath, entries);
  return mapFileEntries(entries, dirPath);
}



function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </svg>
    </button>
  );
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  onDropFiles,
  t,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken: string;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  onDropFiles?: (targetDirectory: string, files: File[]) => void;
  t: Translate;
}) {
  const open = expandedPaths.has(node.fullPath);
  const highlighted = highlightedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const dragCounterRef = useRef(0);

  // 拖拽上传：只接受来自文件系统的文件（types 含 "Files"），且只有目录行可作 drop 目标。
  const handleDragEnter = useCallback((event: React.DragEvent) => {
    if (!node.isDir) return;
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current += 1;
    setIsDropTarget(true);
  }, [node.isDir]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!node.isDir) return;
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, [node.isDir]);

  const handleDragLeave = useCallback(() => {
    if (!node.isDir) return;
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDropTarget(false);
    }
  }, [node.isDir]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    if (!node.isDir) return;
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = 0;
    setIsDropTarget(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onDropFiles?.(node.fullPath, files);
  }, [node.isDir, node.fullPath, onDropFiles]);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // Re-fetch children when the tree refreshes and the directory is open.
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  // 展开即加载：目录被展开（含 reveal 预置祖先路径后的级联挂载）时自动拉取子项。
  useEffect(() => {
    if (open) void loadChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      onToggleExpanded(node.fullPath, !open);
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, open, onOpenFile, onToggleExpanded]);

  return (
    <div>
      <div
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: 24,
          cursor: "pointer",
          background: isDropTarget
            ? "color-mix(in srgb, var(--accent) 22%, var(--bg-selected))"
            : hovered
              ? "var(--bg-hover)"
              : "transparent",
          borderRadius: 4,
          userSelect: "none",
          outline: isDropTarget ? "2px solid var(--accent)" : "none",
          outlineOffset: -2,
        }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {highlighted && (
          <span
            title={t("files.newlyUploaded")}
            aria-label={t("files.newlyUploaded")}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6" }} />
          </span>
        )}
        {!hovered && !node.isDir && gitStatus && (
          <GitStatusBadge status={gitStatus} t={t} />
        )}
        {!hovered && containsGitChanges && (
          <span
            title={t("files.containsChangedFiles")}
            aria-label={t("files.containsChangedFiles")}
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d6a84b" }} />
          </span>
        )}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {onAtMention && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            title={t("files.insertPath")}
            style={{
              position: "absolute",
              right: !node.isDir ? 28 : 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <MentionIcon />
            {t("files.mention")}
          </button>
        )}
        {hovered && !node.isDir && (
          <a
            href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
            download
            onClick={(e) => e.stopPropagation()}
            title={t("files.download")}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              textDecoration: "none",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              onDropFiles={onDropFiles}
              t={t}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}



export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
  gitStatusByPath,
  changedDirectoryPaths,
  onUploadTargetChange,
  reveal,
}, ref) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [uploadTarget, setUploadTarget] = useState<string>(cwd);
  const prevCwdRef = useRef<string | null>(null);
  const prevRefreshTokenRef = useRef<string>("");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
    // 方案 A：展开一个目录即把它记为上传目标；折叠不改变目标，避免误触。
    if (open) setUploadTarget(fullPath);
  }, []);

  const applyUploadResult = useCallback((target: string, data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ target, uploaded, skipped, errors });

    if (uploaded.length > 0) {
      // 上传目标可能是子目录：精确失效该目录缓存，让已展开的树立刻显示新文件。
      invalidateDirectory(target);
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(target, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, []);

  const performUpload = useCallback(async (
    target: string,
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(target, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          target,
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(target, data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult]);

  const prepareUpload = useCallback(async (target: string, files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    // 同步上传目标状态：按钮 tooltip / 冲突提示都跟随本次上传的实际目录。
    setUploadTarget(target);
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(target)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          target,
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(target, files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(uploadTarget, files);
  }, [prepareUpload, uploadTarget]);

  const handleDropFiles = useCallback((targetDirectory: string, files: File[]) => {
    void prepareUpload(targetDirectory, files);
  }, [prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
  }), [uploadBusy]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  // 把上传目标（相对 cwd 的路径，根目录为空串）同步给父组件以更新按钮 tooltip。
  useEffect(() => {
    const rel =
      normalizeFilePathSlashes(uploadTarget) === normalizeFilePathSlashes(cwd)
        ? ""
        : getRelativeFilePath(uploadTarget, cwd);
    onUploadTargetChange?.(rel);
  }, [onUploadTargetChange, uploadTarget, cwd]);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;
    // refreshKey/treeRefreshKey 变化时失效当前目录缓存（强制下次重新拉取）；
    // cwd 变化（切 workspace）时不失效，以便切回时命中缓存。
    const refreshChanged = prevRefreshTokenRef.current !== refreshToken;
    prevRefreshTokenRef.current = refreshToken;
    if (!cwdChanged && refreshChanged) {
      invalidateDirectory(cwd);
    }

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      setUploadTarget(cwd);
    }

    setLoading(cwdChanged);
    setError(null);
    let cancelled = false;
    fetchEntries(cwd)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, refreshToken]);

  // reveal（Loops 面板定位）：把目标目录的全部祖先（含其本身）的绝对路径逐级算出，
  // 一次性并入展开集（保留既有展开项）；各级 TreeNode 的「展开即加载」effect 级联拉取子项。
  // 声明在 cwd 主 effect 之后：切 cwd 时先重置展开集，再按新 cwd 重新定位。
  useEffect(() => {
    if (!reveal) return;
    const segments = reveal.path.split("/").filter(Boolean);
    if (segments.length === 0) return;
    const ancestors: string[] = [];
    let acc = cwd;
    for (const seg of segments) {
      acc = joinFilePath(acc, seg);
      ancestors.push(acc);
    }
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const p of ancestors) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [reveal, cwd]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    // 用 uploadSummary.target 而非当前的 uploadTarget：避免上传完成后用户又展开
    // 别的目录导致 mention 路径漂移。
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(uploadSummary.target, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  return (
    <div style={{ minHeight: "100%" }}>
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-5.7-8.4" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width 120ms ease" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, #f59e0b 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, #f59e0b 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "#f59e0b", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.target, pendingConflict.files, "overwrite")} style={{ height: 22, padding: "0 7px", border: "1px solid #ef4444", borderRadius: 4, background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 10 }}>
                {t("files.replace")}
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.target, pendingConflict.files, "skip")} style={{ height: 22, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}>
                {t("files.skipExisting")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
                {t("files.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "#f87171" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={`${uploadSummary.uploaded.length} uploaded`} aria-label={`${uploadSummary.uploaded.length} uploaded`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#22c55e" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={`${uploadSummary.skipped.length} skipped`} aria-label={`${uploadSummary.skipped.length} skipped`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 12h8" />
                    </svg>
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={`${uploadSummary.errors.length} failed`} aria-label={`${uploadSummary.errors.length} failed`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#f87171" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3 2.5 20h19L12 3Z" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  aria-label={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  style={{ height: 22, padding: "0 7px", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  <MentionIcon />
                  {t("files.mention")}
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "#f87171" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 17h.01" />
                </svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      <div style={{ padding: "2px 4px" }}>
          {loading ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>Loading files...</div>
          ) : error ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{error}</div>
          ) : (
            roots.map((node) => (
              <TreeNode
                key={node.fullPath}
                node={node}
                depth={0}
                cwd={cwd}
                onOpenFile={onOpenFile}
                onAtMention={onAtMention}
                expandedPaths={expandedPaths}
                onToggleExpanded={handleToggleExpanded}
                refreshToken={refreshToken}
                highlightedPaths={highlightedPaths}
                gitStatusByPath={gitStatusByPath}
                changedDirectoryPaths={changedDirectoryPaths}
                onDropFiles={handleDropFiles}
                t={t}
              />
            ))
          )}
          {!loading && !error && roots.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("files.noFiles")}
            </div>
          )}
        </div>
    </div>
  );
});
