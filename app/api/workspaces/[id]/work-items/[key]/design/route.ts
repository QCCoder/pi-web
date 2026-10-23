import { NextResponse } from "next/server";
import { readDesign, updateDesignContent } from "@/lib/work-items/delivery";
import type { UpdateDesignContentInput } from "@/lib/work-items/delivery";
import { workItemErrorResponse } from "@/lib/work-items/web";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    return NextResponse.json(await readDesign(id, key));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  try {
    const { id, key } = await params;
    const input = await req.json() as UpdateDesignContentInput;
    return NextResponse.json(await updateDesignContent(id, key, input));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
