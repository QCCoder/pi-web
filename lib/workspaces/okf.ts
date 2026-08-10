/**
 * OKF (Open Knowledge Format) v0.2 conventions for Pi Web knowledge bundles.
 *
 * OKF is a deliberately minimal, git-backed, Markdown + YAML-frontmatter knowledge
 * format whose whole point is that an agent needs **no dedicated tool** to read or
 * traverse it (redesign decision 11 "L0", decision 13 "adopt OKF v0.2"). `read`,
 * `ls`, and `grep` over the bundle directory are sufficient — that tool-free access
 * is called "L0" and it is always built-in.
 *
 * See `docs/workspace-redesign.md` §4 (知识库专题 OKF) for the rationale and the
 * OKF → design mapping table.
 *
 * This module only owns the *structure convention* + the *seed generator* for newly
 * initialized knowledge repositories. It deliberately stays free of any service /
 * git / manifest logic, and `templates.ts` imports from here rather than the other
 * way around to avoid a circular dependency (service.ts → templates.ts).
 */

/** OKF format version this seed targets. */
export const OKF_VERSION = "0.2";

/**
 * Structural role of a note, stored in its frontmatter `type` field. These are the
 * well-known values Pi Web seeds; OKF allows arbitrary `type` values — agents still
 * read unknown-typed notes, they just carry no special Pi semantics.
 */
export const OKF_TYPE_INDEX = "index";
export const OKF_TYPE_LOG = "log";
export const OKF_TYPE_CONCEPT = "concept";

/** The progressive-disclosure entry point every OKF bundle MUST have. An agent
 *  starts here: it lists the root concepts and explains how to traverse the bundle
 *  with only `read`/`ls`/`grep` (L0). */
export const OKF_INDEX_FILE = "index.md";

/** Append-only change log every OKF bundle SHOULD have. */
export const OKF_LOG_FILE = "log.md";

/** Default root-concept directory used by the seed. OKF does not mandate a layout,
 *  but seeding `concepts/` gives new bundles a sensible place to grow. */
export const OKF_CONCEPTS_DIR = "concepts";

/** Output of {@link renderOkfSeed}: relative path → file content for the seed. */
export interface OkfSeed {
  files: Record<string, string>;
}

/**
 * Generate the initial OKF v0.2 file set for a freshly **initialized** knowledge
 * repository (`addWorkspaceRepository` with `mode: "init"`). Cloned knowledge repos
 * are never overwritten — they bring their own OKF structure from the remote.
 *
 * The seed contains:
 * - `index.md` — progressive-disclosure entry (frontmatter `type: index`).
 * - `log.md` — append-only change log (frontmatter `type: log`).
 * - `concepts/welcome.md` — a frontmatter'd example concept (`type: concept` + tags)
 *   so the bundle is non-empty and immediately traversable.
 *
 * @param alias The repository alias (e.g. `product-docs`). Used to title the bundle.
 */
export function renderOkfSeed(alias: string): OkfSeed {
  const title = humanizeAlias(alias);
  const today = new Date().toISOString().slice(0, 10);
  return {
    files: {
      [OKF_INDEX_FILE]: renderOkfIndex(title),
      [OKF_LOG_FILE]: renderOkfLog(today, title),
      [`${OKF_CONCEPTS_DIR}/welcome.md`]: renderOkfWelcomeConcept(title),
    },
  };
}

function humanizeAlias(alias: string): string {
  return alias
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function renderOkfIndex(title: string): string {
  return `---
type: ${OKF_TYPE_INDEX}
---

# ${title}

This is an **OKF (Open Knowledge Format v0.2)** knowledge bundle: a directory tree of
Markdown notes, each carrying a small YAML frontmatter. **No special tool is required
to read it** — \`read\`, \`ls\`, and \`grep\` over this directory are all you need. This
tool-free access is called **L0** and it is always available.

## How to traverse (L0)

1. Start here: this \`index.md\` lists the root concepts (see "Root concepts" below).
2. Open a concept note with \`read\`; follow the Markdown links inside it to related notes.
3. To find something specific, \`grep\` keywords across \`**/*.md\`, or enumerate notes by
   frontmatter — e.g. \`grep -rn "^type: concept"\` lists every concept.
4. \`log.md\` records notable changes to the bundle.

## Frontmatter convention (OKF v0.2)

Every note SHOULD carry YAML frontmatter:

- \`type\` — the structural role of the note. Well-known values: \`${OKF_TYPE_INDEX}\`,
  \`${OKF_TYPE_CONCEPT}\`, \`${OKF_TYPE_LOG}\`. Unknown values are allowed; agents still
  read them, they just carry no special semantics.
- \`tags\` — optional list of free-form tags for cross-cutting grouping.

## Root concepts

- [Welcome](concepts/welcome.md) — a short example concept to start from.

> **Progressive disclosure:** keep this file as the single entry point. When you add a
> new top-level concept under \`concepts/\` (or any subdirectory), link it from here so an
> agent that follows this index discovers it.
`;
}

function renderOkfLog(today: string, title: string): string {
  return `---
type: ${OKF_TYPE_LOG}
---

# ${title} change log

- ${today} — Initialized this knowledge bundle (OKF v0.2 seed).
`;
}

function renderOkfWelcomeConcept(title: string): string {
  return `---
type: ${OKF_TYPE_CONCEPT}
tags: [getting-started]
---

# Welcome to ${title}

This is an example **concept** note. A concept explains a single idea in this knowledge
base and links to related concepts.

## What to put here

Replace this placeholder with a real concept. A good concept note:

- Has a clear title and a one-sentence summary up top.
- Links to related concepts with Markdown links.
- Carries \`tags\` in the frontmatter for cross-cutting grouping.

## Related

- Back to the [index](../index.md).
`;
}
