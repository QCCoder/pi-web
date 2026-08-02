import { NextResponse } from "next/server";
import {
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceValidationError,
} from "../workspaces/service";
import {
  WorkItemConflictError,
  WorkItemNotFoundError,
  WorkItemValidationError,
} from "./service";

export function workItemErrorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkItemNotFoundError || error instanceof WorkspaceNotFoundError
    ? 404
    : error instanceof WorkItemConflictError || error instanceof WorkspaceConflictError
      ? 409
      : error instanceof WorkItemValidationError || error instanceof WorkspaceValidationError
        ? 400
        : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}
