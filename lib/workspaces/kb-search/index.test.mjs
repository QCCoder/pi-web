import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ensureIndex,
  kbIndexCachePath,
  searchIndex,
  tokenize,
} from "./index.ts";

/** Temp workspace root + helper to lay out a knowledge bundle on disk. */
async function fixtureWorkspace(t) {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-kb-"));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  return workspacePath;
}

async function makeRepo(workspacePath, alias, files) {
  const repoPath = join(workspacePath, "repositories", "knowledge", alias);
  await mkdir(repoPath, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(repoPath, ...rel.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return { alias, path: repoPath };
}

const deploymentNote = `---
type: concept
tags: [infra, deployment]
---

# Deployment Runbook

To deploy the service, run the blue-green deployment script. It switches traffic
atomically and rolls back automatically on health-check failure.
`;

const onboardingNote = `---
type: concept
tags: [onboarding]
---

# Onboarding Guide

New engineers follow the onboarding guide: clone the repo, install dependencies,
and run the test suite before pushing their first commit.
`;

test("tokenize splits ASCII words and keeps CJK unigram/bigram", () => {
  const tokens = tokenize("Blue-Green deployment 你好世界 test");
  assert.ok(tokens.includes("blue"));
  assert.ok(tokens.includes("green"));
  assert.ok(tokens.includes("deployment"));
  assert.ok(tokens.includes("test"));
  // CJK unigram + bigram present.
  assert.ok(tokens.includes("你"));
  assert.ok(tokens.includes("你好"));
  // Single ASCII characters are dropped (noise).
  assert.ok(!tokens.includes("a"));
});

test("ensureIndex indexes new files and search ranks them", async (t) => {
  const workspacePath = await fixtureWorkspace(t);
  const repo = await makeRepo(workspacePath, "docs", {
    "deployment.md": deploymentNote,
    "onboarding.md": onboardingNote,
  });

  const index = await ensureIndex(workspacePath, repo);
  assert.equal(index.repoAlias, "docs");
  assert.equal(index.docCount, 2);

  const results = searchIndex("deployment rollback", [index]);
  assert.equal(results.length, 1);
  assert.equal(results[0].repoAlias, "docs");
  assert.equal(results[0].path, "deployment.md");
  assert.equal(results[0].title, "Deployment Runbook");
  assert.match(results[0].snippet, /deployment/i);
  assert.ok(results[0].score > 0);
  assert.equal(results[0].type, "concept");
  assert.deepEqual(results[0].tags, ["infra", "deployment"]);
});

test("ensureIndex skips re-parsing files whose mtime is unchanged (decision 14)", async (t) => {
  const workspacePath = await fixtureWorkspace(t);
  const repo = await makeRepo(workspacePath, "docs", {
    "deployment.md": deploymentNote,
  });
  const cachePath = kbIndexCachePath(workspacePath, "docs");
  const notePath = join(repo.path, "deployment.md");

  // Hand-craft a cache entry whose recorded mtime exactly matches the file's real
  // mtime, but whose *content* is deliberately stale. ensureIndex must reuse the
  // stale entry (mtime hit) instead of re-parsing — so a search for the stale word
  // hits and the real word does not. This deterministically exercises the
  // mtime-skip branch without depending on utimes round-trip precision.
  const realMtime = (await stat(notePath)).mtimeMs;
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify({
      schemaVersion: 1,
      repoAlias: "docs",
      docs: [
        {
          path: "deployment.md",
          title: "Stale Title",
          mtime: realMtime,
          termFreq: { plumbing: 5 },
          content: "stale content only about plumbing",
        },
      ],
    }),
    "utf8",
  );

  const reused = await ensureIndex(workspacePath, repo);
  assert.equal(reused.docs[0].title, "Stale Title"); // reused, not re-parsed
  assert.equal(searchIndex("plumbing", [reused]).length, 1); // stale word present
  assert.equal(searchIndex("deployment", [reused]).length, 0); // real word absent

  // Bump the file's mtime well past realMtime (5s, robust even on 1s-granularity
  // filesystems). Now ensureIndex re-parses and the real content shows through.
  const futureSec = realMtime / 1000 + 5;
  await utimes(notePath, futureSec, futureSec);
  const refreshed = await ensureIndex(workspacePath, repo);
  assert.equal(refreshed.docs[0].title, "Deployment Runbook");
  assert.equal(searchIndex("deployment", [refreshed]).length, 1);
  assert.equal(searchIndex("plumbing", [refreshed]).length, 0);
});

test("ensureIndex drops deleted files on the next pass", async (t) => {
  const workspacePath = await fixtureWorkspace(t);
  const repo = await makeRepo(workspacePath, "docs", {
    "deployment.md": deploymentNote,
    "onboarding.md": onboardingNote,
  });
  await ensureIndex(workspacePath, repo);
  await rm(join(repo.path, "onboarding.md"));

  const index = await ensureIndex(workspacePath, repo);
  assert.equal(index.docCount, 1);
  assert.equal(index.docs[0].path, "deployment.md");
});

test("search merges results across multiple active knowledge bundles (§6.1)", async (t) => {
  const workspacePath = await fixtureWorkspace(t);
  const infra = await makeRepo(workspacePath, "infra", {
    "deployment.md": deploymentNote,
  });
  const people = await makeRepo(workspacePath, "people", {
    "onboarding.md": onboardingNote,
  });

  const infraIndex = await ensureIndex(workspacePath, infra);
  const peopleIndex = await ensureIndex(workspacePath, people);

  // "deployment" only lives in infra; "onboarding" only in people.
  assert.deepEqual(
    searchIndex("deployment", [infraIndex, peopleIndex]).map((r) => r.repoAlias),
    ["infra"],
  );
  assert.deepEqual(
    searchIndex("onboarding", [infraIndex, peopleIndex]).map((r) => r.repoAlias),
    ["people"],
  );

  // A term present in both bundles returns merged, ranked results spanning both.
  const merged = searchIndex("engineers", [infraIndex, peopleIndex]);
  assert.deepEqual(
    merged.map((r) => r.repoAlias),
    ["people"],
  );
});

test("a missing or corrupt cache file self-heals into a full rebuild (decision 14)", async (t) => {
  const workspacePath = await fixtureWorkspace(t);
  const repo = await makeRepo(workspacePath, "docs", {
    "deployment.md": deploymentNote,
  });

  // Missing cache: ensureIndex builds from scratch.
  await rm(kbIndexCachePath(workspacePath, "docs"), { force: true });
  let index = await ensureIndex(workspacePath, repo);
  assert.equal(searchIndex("deployment", [index]).length, 1);

  // Corrupt cache (not valid JSON): ensureIndex rebuilds instead of throwing.
  const cachePath = kbIndexCachePath(workspacePath, "docs");
  await writeFile(cachePath, "{ this is not valid json }}}", "utf8");
  index = await ensureIndex(workspacePath, repo);
  assert.equal(index.docCount, 1);
  assert.equal(searchIndex("deployment", [index]).length, 1);

  // Incompatible schema version: also rebuilt.
  await writeFile(
    cachePath,
    JSON.stringify({ schemaVersion: 999, repoAlias: "docs", docs: [] }),
    "utf8",
  );
  index = await ensureIndex(workspacePath, repo);
  assert.equal(searchIndex("deployment", [index]).length, 1);
});

test("frontmatter type/tags act as filter dimensions", async (t) => {
  const workspacePath = await fixtureWorkspace(t);
  const repo = await makeRepo(workspacePath, "docs", {
    "deployment.md": deploymentNote,
    "onboarding.md": onboardingNote,
    "index.md": "---\ntype: index\n---\n\n# Index\n\ndeployment and onboarding concepts live here.\n",
  });
  const index = await ensureIndex(workspacePath, repo);

  // "deployment" appears in the concept note AND the index note (which mentions it).
  const all = searchIndex("deployment", [index]);
  assert.ok(all.length >= 2);

  const conceptsOnly = searchIndex("deployment", [index], {
    filters: { type: "concept" },
  });
  assert.ok(conceptsOnly.length >= 1);
  assert.ok(conceptsOnly.every((r) => r.type === "concept"));
  assert.ok(!conceptsOnly.some((r) => r.type === "index"));

  const taggedInfra = searchIndex("deployment", [index], {
    filters: { tags: ["infra"] },
  });
  assert.ok(taggedInfra.length >= 1);
  assert.ok(taggedInfra.every((r) => r.tags?.includes("infra")));
});

test("empty/stop-word-only queries return no results; limit clamps", async (t) => {
  const workspacePath = await fixtureWorkspace(t);
  const repo = await makeRepo(workspacePath, "docs", {
    "deployment.md": deploymentNote,
    "onboarding.md": onboardingNote,
  });
  const index = await ensureIndex(workspacePath, repo);

  assert.deepEqual(searchIndex("", [index]), []);
  assert.deepEqual(searchIndex("the of and", [index]), []);
  const limited = searchIndex("guide", [index], { limit: 1 });
  assert.ok(limited.length <= 1);
});
