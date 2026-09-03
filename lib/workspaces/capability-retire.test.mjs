import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCapabilities,
  parseWorkspaceManifest,
  WorkspaceValidationError,
} from "./service.ts";

/** Minimal VALID manifest fixture — exactly the fields parseWorkspaceManifest
 *  requires (schema_version/id/slug/name/capabilities/work_items/created_at/
 *  updated_at; skills/repositories/agent/git are optional). */
function manifestWithCapabilities(capabilities) {
  return {
    schema_version: 1,
    id: "01JDYRETIREFIXTURE01",
    slug: "retire-test",
    name: "Retire Test",
    skills: [],
    capabilities,
    repositories: [],
    agent: {},
    work_items: {
      next_requirement_number: 1,
      next_bug_number: 1,
    },
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

test("requirement-sources is stripped from legacy manifests on read", () => {
  const manifest = parseWorkspaceManifest(
    manifestWithCapabilities(["sessions", "explorer", "requirement-sources"]),
  );
  assert.deepEqual(manifest.capabilities, ["sessions", "explorer"]);
});

test("parseCapabilities rejects new requirement-sources writes", () => {
  assert.throws(
    () => parseCapabilities(["requirement-sources"]),
    WorkspaceValidationError,
  );
});
