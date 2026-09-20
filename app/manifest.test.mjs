import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Ported upstream PWA manifest/icon fixes:
// - #379 (upstream 99d4ea1): unset the manifest orientation so the PWA
//   respects the OS rotation lock instead of being forced to "any".
// - #718 (upstream b315bd3): opaque white icon PNGs so the iOS home-screen
//   icon stays readable (iOS fills transparent areas with black and ignores
//   manifest background_color / maskable purposes).

const manifestSource = await readFile(new URL("./manifest.ts", import.meta.url), "utf8");

test("does not lock the PWA orientation so the OS rotation lock is respected", () => {
  assert.doesNotMatch(manifestSource, /orientation/);
});

test("ships opaque icon PNGs with a matching white background color", async () => {
  assert.match(manifestSource, /background_color: "#ffffff"/);
  for (const icon of ["apple-touch-icon.png", "icon-192.png", "icon-512.png"]) {
    const png = await readFile(new URL(`../public/icons/${icon}`, import.meta.url));
    // PNG signature sanity, then the IHDR color-type byte at offset 25:
    // 2 = truecolor RGB (no alpha channel), 6 = truecolor + alpha.
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${icon} is a PNG`);
    assert.equal(png[25], 2, `${icon} must be opaque (no alpha channel)`);
  }
});
