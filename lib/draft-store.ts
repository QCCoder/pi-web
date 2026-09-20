import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();
const hydratedKeys = new Set<string>();
const STORAGE_PREFIX = "pi-web:chat-draft:";

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(key)}`;
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
    drafts.set(key, { value: parsed.value, images });
  } catch {
    // Ignore malformed drafts and unavailable browser storage.
  }
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
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
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
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
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
