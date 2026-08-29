#!/usr/bin/env node
"use strict";

// DEPRECATED shim: the loop host was renamed to the pi-daemon (it owns every
// session, not just loops). This file keeps old shells / systemd units /
// `npm run loop` working — it simply launches the real entry.
console.error("[pi-loop] deprecated: renamed to pi-daemon — use `node bin/pi-daemon.js` / `npm run daemon`");
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./pi-daemon.js");
