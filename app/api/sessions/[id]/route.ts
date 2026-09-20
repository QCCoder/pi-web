import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  readSessionHeader,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionFileStats } from "@/lib/session-stats";
import { deleteArchivedSession, isSessionArchived } from "@/lib/session-archive";
import { skillMessageTitle } from "@/lib/skill-message";
import { daemonProxy } from "@/lib/agent-proxy";

// BranchNavigator still traverses recursively, so keep the response tree shallow.
const MAX_PROJECTED_TREE_DEPTH = 200;

/**
 * Project the session tree into the shallow navigation tree sent to the client.
 * Keeps roots, branch points, and leaves while contracting single-child chains
 * without recursive traversal. Contracted entry IDs are attached to the next
 * visible node so the UI can still recognize an active leaf inside the chain.
 */
function projectTreeForResponse<T extends { entry: { id: string }; children: T[]; compressedEntryIds?: string[] }>(
  nodes: T[]
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (
      roots.has(node) ||
      node.children.length !== 1
    ) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node: T, compressedEntryIds?: string[]): T => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source: T, projectedParent: T) => {
    const pending = [{ node: source, compressedEntryIds: [] as string[] }];
    const flattenedSeen = new Set<T>();

    while (pending.length > 0) {
      const { node, compressedEntryIds } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds: string[] = [];
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Daemon-created session whose .jsonl hasn't been written yet (pi creates
    // the file lazily on the first append). The path is known (seeded by
    // /api/agent/new), so this is not a 404 — answer an empty-but-valid session:
    // the UI renders live SSE events on top of it, and the next reload after the
    // first append picks up the real file.
    if (!existsSync(filePath)) {
      return NextResponse.json({
        sessionId: id,
        filePath,
        info: null,
        leafId: null,
        tree: [],
        context: { messages: [], entryIds: [], thinkingLevel: "", model: null },
        revision: undefined,
      });
    }

    // ETag/revision conditional GET (REQ-0001 决策 3): 切回 session 时客户端带上
    // If-None-Match，文件未变化直接返回 304，省去重新读取/解析大 JSON 的开销。
    // revision 基于 size+mtimeMs：pi 追加写 .jsonl 会改变两者，能可靠反映变化。
    let fileStat: { size: number; mtimeMs: number } | null = null;
    try {
      const st = statSync(filePath);
      fileStat = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      // file may have been removed between resolve and stat; fall through to
      // the normal error path below.
    }
    if (fileStat) {
      const revision = `"${fileStat.size}-${fileStat.mtimeMs}"`;
      if (req.headers.get("if-none-match") === revision) {
        return new NextResponse(null, { status: 304, headers: { ETag: revision } });
      }
    }

    const sm = SessionManager.open(filePath);
    const entries = sm.getEntries() as never;
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    // Tail-first loading (L3): ship only the last N messages for the initial
    // view; older ones arrive via /earlier as the user scrolls up.
    const tailParam = Number(searchParams.get("tail") ?? "");
    const tailMessages = Number.isSafeInteger(tailParam) && tailParam > 0 ? tailParam : undefined;
    const context = buildSessionContext(entries, leafId, { deferThinking, deferToolResultImages, tailMessages });
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation as the SDK's getSessionStats(). Lets the client
    // keep monotonic token/cost counters across compaction, page reloads and
    // branch navigation (upstream 93633c8).
    const stats = computeSessionFileStats(entries);

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sm.getSessionName(),
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            const text = typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "");
            return text ? skillMessageTitle(text) : "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
    } : null;

    const revision = fileStat ? `"${fileStat.size}-${fileStat.mtimeMs}"` : undefined;
    return NextResponse.json(
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        context,
        totalActiveMs,
        stats,
        revision,
      },
      revision ? { headers: { ETag: revision } } : undefined,
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // Rename through the session daemon (C2): a live wrapper may hold the
    // session — writing the file directly from here would race its appends.
    // The daemon cold-starts idle sessions from the .jsonl, so this also
    // covers never-opened sessions.
    const client = await daemonProxy();
    await client.sendSessionCommand(id, { type: "set_session_name", name: name.trim() });
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    // Archived sessions are deleted directly (no fork re-parenting — the
    // parentSession links are preserved so a restore reconnects the tree).
    // Tell the session daemon to destroy a live wrapper first (best-effort;
    // the web layer's file surgery proceeds regardless — a daemon hiccup must
    // not block deletion).
    try {
      const client = await daemonProxy();
      await client.destroySession(id);
    } catch {
      // daemon unreachable — proceed with the file surgery
    }
    if (await isSessionArchived(id)) {
      return NextResponse.json(await deleteArchivedSession(id));
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Daemon-created sessions seed the path cache before pi's first append
    // creates the .jsonl (pi flushes lazily on write). Nothing on disk to
    // read or unlink: treat as already deleted — the wrapper teardown above
    // has happened, so invalidate both caches and answer ok (upstream
    // edf0deb; mirrors GET's empty placeholder for the same state).
    if (!existsSync(filePath)) {
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    }

    // Read only the bounded header before deleting.
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
          if (
            header.type === "session" &&
            header.parentSession &&
            sessionPathKey(header.parentSession) === targetPathKey
          ) {
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            writeFileSync(childPath, lines.join("\n"));
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    unlinkSync(filePath);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
