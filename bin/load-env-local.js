"use strict";

/**
 * Minimal .env.local loader for the pi-daemon process.
 *
 * Why this exists: the daemon is spawned three ways — as a sidecar by the web
 * server (inherits the web process env), via `npm run daemon`, or by hand.
 * Only the sidecar path inherits a web process into which Next.js has already
 * loaded `.env.local`. Self-loading here keeps the pi data-home vars
 * (PI_CODING_AGENT_DIR / PI_WORKSPACES_DIR / PI_WORKSPACE_INDEX_FILE — see
 * `.env.example`) correct in EVERY spawn path, without betting on Next env
 * loading order relative to `instrumentation.ts`.
 *
 * Semantics (deliberately dotenv-lite):
 *   - KEY=VALUE per line; surrounding whitespace trimmed.
 *   - `#` comments and blank lines skipped.
 *   - A value wrapped in matching single/double quotes has them stripped.
 *   - Values already present in process.env are NEVER overridden — an explicit
 *     environment (docker-compose, sidecar inheritance, shell) always wins.
 *   - A missing file is a no-op (the defaults under ~/.pi apply).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

/** Parse .env-format text into an ordered key/value list. */
function parseEnvText(text) {
  const entries = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(['"])([\s\S]*)\1$/);
    if (quoted) value = quoted[2];
    entries.push([key, value]);
  }
  return entries;
}

/**
 * Load `<dir>/.env.local` into process.env (without overriding).
 * @param {string} projectRoot directory that contains .env.local
 * @returns {string[]} the keys that were applied (empty when no file)
 */
function loadEnvLocal(projectRoot) {
  const file = path.join(projectRoot, ".env.local");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const applied = [];
  for (const [key, value] of parseEnvText(text)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

module.exports = { loadEnvLocal, parseEnvText };
