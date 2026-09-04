import { NextResponse } from "next/server";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { addWorkItemAttachments } from "@/lib/work-items/service";
import { workItemErrorResponse } from "@/lib/work-items/web";

// Mirrors /api/files upload limits (app/api/files/[...path]/route.ts).
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    let formData: FormData;
    try {
      formData = await parseFormDataWithinLimit(req, MAX_UPLOAD_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
      }
      throw error;
    }
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.length === 0) {
      return NextResponse.json({ error: "files is required" }, { status: 400 });
    }
    if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
      return NextResponse.json({ error: "Each upload must be 25MB or smaller" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
    }
    const detail = await addWorkItemAttachments(id, key, {
      files: await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          bytes: Buffer.from(await file.arrayBuffer()),
        })),
      ),
    });
    return NextResponse.json(detail);
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
