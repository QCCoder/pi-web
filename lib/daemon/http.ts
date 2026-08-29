import type { IncomingMessage, ServerResponse } from "node:http";
import { WorkItemNotFoundError } from "../work-items/service.ts";
import { WorkspaceNotFoundError } from "../workspaces/service.ts";
import { LoopConflictError, LoopNotFoundError, LoopValidationError } from "../loop/store.ts";

/** Shared HTTP plumbing for the daemon's route modules.
 *
 *  The daemon core composes route handlers from domains (sessions / loop /
 *  importers): each domain exports `createXxxRoutes(deps)` returning this
 *  handler shape, and the host chains them — first handler to claim the
 *  request (returns true) wins; falling through all of them is a 404.
 *  Registration is the mount point: a domain's routes live in the domain's
 *  directory, not in the daemon core. */
export type DaemonRouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) => Promise<boolean>;

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

/** Error → HTTP status mapping shared by every daemon route module. */
export function daemonErrorStatus(error: unknown): number {
  if (error instanceof WorkItemNotFoundError) return 404;
  if (error instanceof WorkspaceNotFoundError) return 404;
  if (error instanceof LoopNotFoundError) return 404;
  if (error instanceof LoopValidationError) return 400;
  if (error instanceof LoopConflictError) return 409;
  return 500;
}
