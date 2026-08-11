/** Importer SPI + data shapes (design §5). An Importer is an *inbound* adapter
 *  that materializes third-party work items (bugs/tasks) into the workspace.
 *  Chandao is the first implementation; the SPI exists so sources are swappable.
 *
 *  The SPI is a deep-module seam: `listAssigned/getDetail/getAttachment` hide
 *  REST+token+binary+field-name differences behind three methods. The runner
 *  (lib/importers/runner.ts) depends only on this interface, never on Chandao. */

// ---- SPI domain shapes -----------------------------------------------------

export type SourceItemKind = "bug" | "task";

export interface AssigneeFilter {
  /** Assignee account; defaults to the importer's configured assignee. */
  assignee?: string;
}

/** A lightweight reference to one assigned source item (no body). */
export interface SourceItem {
  sourceId: string;
  kind: SourceItemKind;
  title: string;
  url?: string;
}

/** Full detail for one source item. `body` carries the raw description HTML
 *  (e.g. Chandao `steps`/`desc`) which may contain `<img>` references. */
export interface SourceItemDetail {
  sourceId: string;
  kind: SourceItemKind;
  title: string;
  body: string;
  url?: string;
}

/** Downloaded attachment bytes + detected extension. */
export interface Attachment {
  bytes: Buffer;
  ext: string;
}

export interface Importer {
  /** Adapter identifier, e.g. "chandao". Stored on the work item's `external.source`. */
  readonly kind: string;
  /** List items currently assigned to the filter (bugs + tasks merged). */
  listAssigned(filter: AssigneeFilter): Promise<SourceItem[]>;
  /** Full detail for one source id; `body` includes original `<img>` references. */
  getDetail(sourceId: string): Promise<SourceItemDetail>;
  /** Download one attachment (by the Chandao `fileID` extracted from `<img>`). */
  getAttachment(fileId: string): Promise<Attachment>;
}

// ---- Credential shapes (mirror lib/feishu/types.ts) ------------------------

/** Per-workspace Chandao REST credentials. Stored outside the workspace dir
 *  (under the global pi agent dir) because the password is sensitive and
 *  workspace dirs are frequently git repos. `token` is optional; re-signed
 *  automatically on 401 using account+password (design §11). */
export interface ChandaoConfig {
  base: string;
  account: string;
  password: string;
  /** Cached API token; may be absent — obtained/re-signed at runtime. */
  token?: string;
  assignee: string;
  productId: number;
  executionId: number;
}

/** Config shape returned to the client / UI — password/token never leave the
 *  server (only "has*" flags). */
export interface ChandaoConfigPublic {
  base: string;
  account: string;
  hasPassword: boolean;
  hasToken: boolean;
  assignee: string;
  productId: number;
  executionId: number;
}

export interface ImporterConfig {
  chandao?: ChandaoConfig;
}

export interface ImporterConfigPublic {
  chandao?: ChandaoConfigPublic;
}
