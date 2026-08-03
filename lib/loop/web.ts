import { NextResponse } from "next/server";
import {
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceValidationError,
} from "../workspaces/service.ts";
import { LoopConflictError, LoopNotFoundError, LoopValidationError } from "./store.ts";

/** Map Loop / Workspace errors to HTTP responses. Mirrors work-items/web.ts. */
export function loopErrorResponse(error: unknown): NextResponse {
  const status = error instanceof LoopNotFoundError || error instanceof WorkspaceNotFoundError
    ? 404
    : error instanceof LoopConflictError || error instanceof WorkspaceConflictError
      ? 409
      : error instanceof LoopValidationError || error instanceof WorkspaceValidationError
        ? 400
        : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}
