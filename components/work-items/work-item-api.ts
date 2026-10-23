"use client";

import type { DeliveryAction } from "@/lib/work-items/delivery-types";
import type { WorkItemDetail } from "@/lib/work-items/types";

/** Shared client fetch helpers for the work-item surfaces (central
 *  WorkItemsPage + WorkspaceManager quick panel, M2 T9): one JSON error
 *  mapping that KEEPS the HTTP status (409 conflict handling needs it) and
 *  one multipart attachment uploader (create flow + detail view reuse the
 *  exact WorkspaceManager semantics). */

/** Error carrying the HTTP status — callers branch on 409 (revision conflict
 *  → prompt a refetch) vs other failures (surface the message). */
export class WorkItemRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkItemRequestError";
    this.status = status;
  }
}

/** JSON response → T; non-2xx throws WorkItemRequestError(data.error). */
export async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new WorkItemRequestError(data.error ?? `HTTP ${response.status}`, response.status);
  }
  return data;
}

/** POST a delivery action (spec §7): body = { expectedRevision, requestId,
 *  payload } → { detail, replayed }. requestId is the idempotency key — one
 *  UUID per user intent (click), so a double-click replay returns the current
 *  state instead of applying twice. */
export async function runDeliveryAction(
  workspaceId: string,
  key: string,
  action: DeliveryAction,
  expectedRevision: number,
  payload: Record<string, unknown>,
): Promise<{ detail: WorkItemDetail; replayed: boolean }> {
  return responseJson<{ detail: WorkItemDetail; replayed: boolean }>(
    await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(key)}/delivery/${encodeURIComponent(action)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision,
          requestId: crypto.randomUUID(),
          payload,
        }),
      },
    ),
  );
}

/** Upload attachments to an EXISTING item (files land under `<item>/attachments/`
 *  and the README gains/extends its `## 附件` section). Shared by the create
 *  flows (upload right after creation) and the detail view. */
export async function uploadWorkItemAttachments(
  workspaceId: string,
  key: string,
  files: File[],
): Promise<WorkItemDetail> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file, file.name);
  }
  return responseJson<WorkItemDetail>(
    await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(key)}/attachments`,
      { method: "POST", body: formData },
    ),
  );
}
