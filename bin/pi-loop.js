#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");
if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createJiti } = require("jiti");
const entry = path.join(__dirname, "..", "lib", "loop", "host.ts");
createJiti(__filename).import(entry)
  .then(({ startLoopHost }) => startLoopHost())
  .catch((error) => {
    console.error("[pi-loop] failed to start:", error);
    process.exit(1);
  });
