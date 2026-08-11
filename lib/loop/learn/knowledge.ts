/** Learning-note formatting for cargo-knowledge (design §7.6). The dev Loop's
 *  learn step appends OKF notes when a round yields a generalizable conclusion.
 *
 *  Anti-pollution rule (§7.6 + decision D6): the Loop ALWAYS creates a new note
 *  file and NEVER edits an existing one. This trivially satisfies "once a human
 *  edits a note it becomes authoritative — the Loop never overwrites": the Loop
 *  does not touch any existing file at all. Trust order (human > loop) is
 *  enforced at READ time in the orchestrator's orient step (LOOP.md policy).
 *
 *  Pure: produces the path + frontmatter+body. The orchestrator writes it via
 *  its normal file tools; this helper only formats. */

export interface LearningNoteInput {
  module: string;
  runId: string;
  /** Short headline (becomes H1). */
  title: string;
  /** The generalizable conclusion / gotcha. */
  body: string;
  tags?: readonly string[];
  /** ts for derivedFrom traceability. */
  ts?: string;
}

/** A unique, deterministic path for one learning note. Including runId guarantees
 *  uniqueness (one note per round at most) and traceability. Always a NEW file. */
export function learningNotePath(module: string, runId: string): string {
  const safe = module.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "module";
  return `learnings/${safe}-${runId}.md`;
}

/** Render an OKF learning note (frontmatter + body). author:loop + autoManaged
 *  mark it as Loop-derived so the trust order (human > loop) can discriminate. */
export function formatLearningNote(input: LearningNoteInput): string {
  const tags = Array.from(new Set([...(input.tags ?? []), input.module])).filter(Boolean);
  const frontmatter: Record<string, unknown> = {
    type: "learning",
    module: input.module,
    author: "loop",
    autoManaged: true,
    derivedFrom: `run:${input.runId}`,
    tags,
  };
  const fm = [
    "---",
    ...Object.entries(frontmatter).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((t) => `  - ${t}`).join("\n")}`;
      if (typeof v === "boolean") return `${k}: ${v}`;
      if (typeof v === "number") return `${k}: ${v}`;
      // Bare strings unquoted (OKF style); quote only when YAML-special.
      const s = String(v);
      const bare = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(s);
      return `${k}: ${bare ? s : JSON.stringify(s)}`;
    }),
    "---",
  ].join("\n");
  return `${fm}

# ${input.title}

${input.body.trim()}

> 来源：研发 Loop run \`${input.runId}\`（${input.module}）。author:loop，按 §7.6 信任序人 > loop；本笔记 Loop 只新增不编辑。
`;
}
