import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments.ts";
import {
  MAX_ATTACHED_FILES,
  type AttachedFile,
} from "./chat-attachments.ts";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

/** 文件附件的持久化形态 = AttachedFile 去掉 uploading（只存已完成的）。 */
export type ChatDraftFile = AttachedFile;

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  /** 文件附件（上传完成的绝对路径引用）；可省（旧草稿无此字段）。 */
  files?: ChatDraftFile[];
}

const drafts = new Map<string, ChatDraft>();
const hydratedKeys = new Set<string>();
const STORAGE_PREFIX = "pi-web:chat-draft:";

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(key)}`;
}

function isValidDraftFile(file: unknown): file is ChatDraftFile {
  if (!file || typeof file !== "object") return false;
  const candidate = file as Partial<ChatDraftFile>;
  return typeof candidate.path === "string" && candidate.path.length > 0
    && typeof candidate.name === "string" && candidate.name.length > 0
    && typeof candidate.size === "number";
}

function draftFiles(files: unknown): ChatDraftFile[] {
  if (!Array.isArray(files)) return [];
  return files.filter(isValidDraftFile).slice(0, MAX_ATTACHED_FILES);
}

/** 构造最小形态草稿：无文件附件时不带 files 键（旧测试与存储形态稳定）。 */
function buildDraft(value: string, images: ChatDraftImage[], files?: ChatDraftFile[]): ChatDraft {
  const draft: ChatDraft = { value, images };
  if (files && files.length > 0) draft.files = files;
  return draft;
}

function hydrateDraft(key: string): void {
  if (hydratedKeys.has(key) || typeof window === "undefined") return;
  hydratedKeys.add(key);
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<ChatDraft>;
    if (typeof parsed.value !== "string" || !Array.isArray(parsed.images)) return;
    const images = parsed.images.filter((image): image is ChatDraftImage => Boolean(
      image && typeof image.data === "string" && typeof image.mimeType === "string",
    ));
    drafts.set(key, buildDraft(parsed.value, images, draftFiles(parsed.files)));
  } catch {
    // Ignore malformed drafts and unavailable browser storage.
  }
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return buildDraft(
    draft.value,
    draft.images.map((image) => ({ ...image })),
    draft.files?.map((file) => ({ ...file })),
  );
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && (draft.files?.length ?? 0) === 0;
}

export function getDraft(key: string): ChatDraft | null {
  hydrateDraft(key);
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  hydratedKeys.add(key);
  if (isEmptyDraft(draft)) {
    clearDraft(key);
    return;
  }
  const copy = cloneDraft(draft);
  drafts.set(key, copy);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(key), JSON.stringify(copy));
  } catch {
    // Keep the in-memory draft when storage is unavailable or over quota.
  }
}

export function clearDraft(key: string): void {
  hydratedKeys.add(key);
  drafts.delete(key);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(key));
  } catch {
    // Ignore unavailable browser storage.
  }
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
  submittedFiles?: ChatDraftFile[],
  currentFiles?: ChatDraftFile[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  // 文件按 path 去重后合并（rekey 场景两侧都可能有）；发送失败回填路径不传
  // submittedFiles——引用已在恢复文本里，不能二次成 chip 否则下轮发送重复追加。
  const fileMap = new Map<string, ChatDraftFile>();
  for (const file of [...(currentFiles ?? []), ...(submittedFiles ?? [])]) {
    if (isValidDraftFile(file)) fileMap.set(file.path, file);
  }
  const files = [...fileMap.values()].slice(0, MAX_ATTACHED_FILES);

  return buildDraft(
    mergeRestoredSubmissionText(submittedText, currentText),
    images,
    files,
  );
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  // 刻意不传 submittedFiles：发送前附件已清（引用在 text 里），见上。
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
    undefined,
    current.files,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images, next.files, previous.files)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
