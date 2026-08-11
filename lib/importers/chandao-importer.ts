import { detectImageExt } from "./images.ts";
import type {
  AssigneeFilter,
  Attachment,
  ChandaoConfig,
  SourceItem,
  SourceItemDetail,
  SourceItemKind,
} from "./types.ts";

/** Minimal fetch-like function signature (compatible with global `fetch`). The
 *  importer injects this so tests can mock HTTP without touching the network. */
export type ChandaoFetch = typeof fetch;

/** Chandao statuses that mean "ready to be developed" (待开发): a bug that is
 *  still `active` (needs fixing), or a task in `doing` (the team marks tasks to
 *  develop by setting them to `doing`). Resolved/closed bugs and wait/done/closed
 *  tasks are excluded. Drives the `listAssigned` filter. */
const READY_STATUSES: Record<SourceItemKind, ReadonlyArray<string>> = {
  bug: ["active"],
  task: ["doing"],
};

/** Extract the assignee account from a Chandao `assignedTo` field, which is an
 *  object `{account, realname, ...}` on detail/list responses (and may be null
 *  for parent/deleted users). */
function assignedToAccount(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") return (value as { account?: string }).account;
  return undefined;
}

/** Chandao (禅道) REST+Token Importer (design §5 + appendix A). Uses the token
 *  API (`POST /api.php/v1/tokens`), NOT the web-login md5 flow. Tokens are
 *  cached in-memory and re-signed automatically on 401 using account+password.
 *
 *  Field-name differences are hidden here: bug detail body is `steps`, task
 *  detail body is `desc`; task list title is `name`. Callers see a uniform
 *  SourceItem/SourceItemDetail. */
export class ChandaoImporter {
  readonly kind = "chandao";

  private readonly fetchImpl: ChandaoFetch;
  private cachedToken: string | undefined;
  private readonly config: ChandaoConfig;

  constructor(config: ChandaoConfig, deps?: { fetchImpl?: ChandaoFetch }) {
    this.config = config;
    this.fetchImpl = deps?.fetchImpl ?? fetch;
    this.cachedToken = config.token;
  }

  private get base(): string {
    return this.config.base.replace(/\/$/, "");
  }

  private async signIn(): Promise<string> {
    const response = await this.fetchImpl(`${this.base}/api.php/v1/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: this.config.account, password: this.config.password }),
    });
    if (!response.ok) {
      const text = await safeText(response);
      throw new Error(`Chandao sign-in failed (HTTP ${response.status}): ${text}`);
    }
    const data = (await response.json().catch(() => ({}))) as { token?: string };
    if (!data.token) throw new Error("Chandao sign-in returned no token");
    this.cachedToken = data.token;
    return data.token;
  }

  /** Authenticated GET/POST; re-signs once on 401. */
  private async request(path: string, init?: RequestInit): Promise<Response> {
    const token = this.cachedToken ?? (await this.signIn());
    const headers: Record<string, string> = {
      Token: token,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    let response = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
    if (response.status === 401) {
      const fresh = await this.signIn();
      headers.Token = fresh;
      response = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
    }
    return response;
  }

  async listAssigned(filter: AssigneeFilter = {}): Promise<SourceItem[]> {
    const assignee = (filter.assignee ?? this.config.assignee).trim();
    if (!assignee) throw new Error("Chandao importer requires an assignee");
    const [bugs, tasks] = await Promise.all([
      this.listBugs(assignee),
      this.listTasks(assignee),
    ]);
    return [...bugs, ...tasks];
  }

  private async listBugs(assignee: string): Promise<SourceItem[]> {
    const response = await this.request(
      `/api.php/v1/products/${this.config.productId}/bugs?assignedTo=${encodeURIComponent(assignee)}`,
    );
    if (!response.ok) throw new Error(`Chandao bugs list failed (HTTP ${response.status})`);
    // NOTE: the Chandao REST API IGNORES the `assignedTo` query param (it returns
    // every bug/task in the product/execution regardless), so we filter by both
    // status and the real assignee client-side.
    const data = (await response.json().catch(() => ({}))) as { bugs?: Array<{ id: number; title?: string; status?: string; assignedTo?: unknown }> };
    return (data.bugs ?? [])
      .filter((bug) => READY_STATUSES.bug.includes(bug.status ?? "") && assignedToAccount(bug.assignedTo) === assignee)
      .map((bug) => ({
        sourceId: String(bug.id),
        kind: "bug" as const,
        title: bug.title ?? `Bug #${bug.id}`,
        url: `${this.base}/index.php?m=bug&f=view&bugID=${bug.id}`,
      }));
  }

  private async listTasks(assignee: string): Promise<SourceItem[]> {
    const response = await this.request(
      `/api.php/v1/executions/${this.config.executionId}/tasks?assignedTo=${encodeURIComponent(assignee)}`,
    );
    if (!response.ok) throw new Error(`Chandao tasks list failed (HTTP ${response.status})`);
    const data = (await response.json().catch(() => ({}))) as { tasks?: Array<{ id: number; name?: string; status?: string; assignedTo?: unknown }> };
    return (data.tasks ?? [])
      .filter((task) => READY_STATUSES.task.includes(task.status ?? "") && assignedToAccount(task.assignedTo) === assignee)
      .map((task) => ({
        sourceId: String(task.id),
        kind: "task" as const,
        title: task.name ?? `Task #${task.id}`,
        url: `${this.base}/index.php?m=task&f=view&taskID=${task.id}`,
      }));
  }

  async getDetail(sourceId: string): Promise<SourceItemDetail> {
    const kind = await this.detectKind(sourceId);
    if (kind === "bug") return this.getBugDetail(sourceId);
    return this.getTaskDetail(sourceId);
  }

  /** Detail endpoint chosen by kind. Callers that already know the kind from
   *  listAssigned can pass it to avoid the probe. */
  async getDetailKind(sourceId: string, kind: SourceItemKind): Promise<SourceItemDetail> {
    return kind === "bug" ? this.getBugDetail(sourceId) : this.getTaskDetail(sourceId);
  }

  private async getBugDetail(sourceId: string): Promise<SourceItemDetail> {
    const response = await this.request(`/api.php/v1/bugs/${encodeURIComponent(sourceId)}`);
    if (!response.ok) throw new Error(`Chandao bug ${sourceId} detail failed (HTTP ${response.status})`);
    const data = (await response.json().catch(() => ({}))) as { id?: number; title?: string; steps?: string };
    return {
      sourceId: String(data.id ?? sourceId),
      kind: "bug",
      title: data.title ?? `Bug #${sourceId}`,
      body: data.steps ?? "",
      url: `${this.base}/index.php?m=bug&f=view&bugID=${sourceId}`,
    };
  }

  private async getTaskDetail(sourceId: string): Promise<SourceItemDetail> {
    const response = await this.request(`/api.php/v1/tasks/${encodeURIComponent(sourceId)}`);
    if (!response.ok) throw new Error(`Chandao task ${sourceId} detail failed (HTTP ${response.status})`);
    const data = (await response.json().catch(() => ({}))) as { id?: number; name?: string; desc?: string };
    return {
      sourceId: String(data.id ?? sourceId),
      kind: "task",
      title: data.name ?? `Task #${sourceId}`,
      body: data.desc ?? "",
      url: `${this.base}/index.php?m=task&f=view&taskID=${sourceId}`,
    };
  }

  /** Probe whether a sourceId is a bug or task by trying the bug endpoint first.
   *  Used only by getDetail when the kind is unknown; listAssigned already knows. */
  private async detectKind(sourceId: string): Promise<SourceItemKind> {
    const response = await this.request(`/api.php/v1/bugs/${encodeURIComponent(sourceId)}`);
    return response.ok ? "bug" : "task";
  }

  async getAttachment(fileId: string): Promise<Attachment> {
    const response = await this.request(`/api.php/v1/files/${encodeURIComponent(fileId)}`);
    if (!response.ok) throw new Error(`Chandao file ${fileId} download failed (HTTP ${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = detectImageExt(buffer, response.headers.get("content-type") ?? undefined);
    return { bytes: buffer, ext };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
