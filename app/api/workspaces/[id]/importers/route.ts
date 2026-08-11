import { NextResponse } from "next/server";
import {
  getWorkspace,
  WorkspaceNotFoundError,
} from "@/lib/workspaces/service";
import {
  readImporterConfig,
  writeImporterConfig,
  toPublicConfig,
} from "@/lib/importers/config";
import type { ChandaoConfig, ImporterConfig } from "@/lib/importers/types";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

function parsePositiveInteger(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return num;
}

/** GET the workspace importer config (password/token masked). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    const config = await readImporterConfig(manifest.id);
    return NextResponse.json({ config: toPublicConfig(config) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** PUT (create or update) the Chandao importer config. An empty password keeps
 *  the previously stored password (same convention as Feishu appSecret), so the
 *  UI can edit other fields without re-entering the secret. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    const body = (await req.json()) as {
      base?: string;
      account?: string;
      password?: string;
      token?: string;
      assignee?: string;
      productId?: number;
      executionId?: number;
    };

    const existing = await readImporterConfig(manifest.id);
    const prev = existing?.chandao;

    const base = (body.base ?? prev?.base ?? "").trim();
    const account = (body.account ?? prev?.account ?? "").trim();
    // Empty password keeps the stored secret.
    const password = (body.password && body.password.trim()) || prev?.password || "";
    // token is optional; empty string keeps the stored token, explicit null clears it.
    const keepToken = body.token === undefined || (typeof body.token === "string" && body.token.trim() === "");
    const token = keepToken ? prev?.token : (body.token?.trim() || undefined);
    const assignee = (body.assignee ?? prev?.assignee ?? account).trim();
    const productId = parsePositiveInteger(body.productId ?? prev?.productId, "productId");
    const executionId = parsePositiveInteger(body.executionId ?? prev?.executionId, "executionId");

    if (!base || !account || !password || !assignee) {
      return NextResponse.json(
        { error: "base, account, password and assignee are all required" },
        { status: 400 },
      );
    }

    const chandao: ChandaoConfig = {
      base,
      account,
      password,
      assignee,
      productId,
      executionId,
      ...(token ? { token } : {}),
    };
    const config: ImporterConfig = { chandao };
    await writeImporterConfig(manifest.id, config);
    return NextResponse.json({ config: toPublicConfig(config) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE clears the stored importer config for the workspace. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { manifest } = await getWorkspace(id);
    await writeImporterConfig(manifest.id, {});
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
