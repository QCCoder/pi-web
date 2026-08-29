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
const entry = path.join(__dirname, "..", "lib", "daemon", "host.ts");
createJiti(__filename).import(entry)
  .then(({ startDaemon }) => startDaemon())
  .catch((error) => {
    // Sidecar spawn race (see lib/session-daemon/sidecar.ts): if another
    // daemon already owns the port, this loser exits quietly instead of
    // surfacing an error — the winner serves the same role.
    if (error && typeof error === "object" && error.code === "EADDRINUSE") {
      console.log("[pi-daemon] another daemon already owns the port — this sidecar exits");
      process.exit(0);
    }
    console.error("[pi-daemon] failed to start:", error);
    process.exit(1);
  });
