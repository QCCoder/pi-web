import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  MAX_ATTACHED_FILES,
  MAX_ATTACHED_FILE_BYTES,
} from "@/lib/chat-attachments";
import {
  buildUploadDestination,
  chatUploadsRoot,
  sanitizeUploadFileName,
  writeUploadFile,
} from "@/lib/uploads-root";

// Mirrors the work-item attachments route (app/api/workspaces/[id]/work-items/[key]/attachments/route.ts).
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024;

/**
 * POST /api/uploads — 聊天文件附件上传（multipart `files`）。
 *
 * 落盘位置由服务端决定（`<agentDir>/uploads/<yyyymmdd>/<HHmmss>-<rand6>-<name>`，
 * 见 lib/uploads-root.ts），客户端不能指定路径；文件名经安全化（剥路径、
 * 去控制字符），同名不覆盖（wx + 随机段）。成功返回
 * `{ files: [{ path, name, size }] }`，path 为绝对路径——发送时以
 * `[附件 name](path)` 引用追加进消息文本（lib/chat-attachments.ts）。
 */
export async function POST(request: Request) {
  if (!(await isApiRequestAllowed(request))) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    let formData: FormData;
    try {
      formData = await parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES);
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
    if (files.length > MAX_ATTACHED_FILES) {
      return NextResponse.json({ error: `At most ${MAX_ATTACHED_FILES} files per upload` }, { status: 400 });
    }
    if (files.some((file) => file.size > MAX_ATTACHED_FILE_BYTES)) {
      return NextResponse.json({ error: "Each upload must be 25MB or smaller" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
    }

    const root = chatUploadsRoot();
    const saved: Array<{ path: string; name: string; size: number }> = [];
    try {
      for (const file of files) {
        const name = sanitizeUploadFileName(file.name);
        if (!name) {
          return NextResponse.json({ error: `Invalid file name: ${file.name}` }, { status: 400 });
        }
        const destination = buildUploadDestination(root, new Date(), name);
        writeUploadFile(destination, Buffer.from(await file.arrayBuffer()));
        saved.push({ path: destination, name, size: file.size });
      }
    } catch (error) {
      // 部分落盘的残留不必回滚（孤儿文件无害、按天分桶可清理），但要报错。
      console.error("[uploads] write failed", error);
      return NextResponse.json({ error: "Failed to write upload" }, { status: 500 });
    }
    return NextResponse.json({ files: saved });
  } catch (error) {
    console.error("[uploads] request failed", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
