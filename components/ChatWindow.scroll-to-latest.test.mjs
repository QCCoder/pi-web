import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const lazyLoadSource = await readFile(new URL("../lib/chat-lazy-load.ts", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

function elementBlock() {
  const start = source.indexOf("className={`chat-scroll-to-bottom");
  assert.notEqual(start, -1, "scroll-to-latest button not found");
  const buttonStart = source.lastIndexOf("<button", start);
  const buttonEnd = source.indexOf("</button>", start);
  assert.notEqual(buttonStart, -1);
  assert.notEqual(buttonEnd, -1);
  return source.slice(buttonStart, buttonEnd);
}

test("shows the scroll-to-latest button only when the viewport is detached from the tail", () => {
  // 可见性 = 类切换（退出过渡才能播）；恢复期抑制读 pendingScrollRestoreRef
  // （本地适配：上游为 hook 内 state，本地 ref 已由 T13 恢复管线维护）。
  assert.match(
    source,
    /className=\{`chat-scroll-to-bottom\$\{showScrollToLatest && !pendingScrollRestoreRef\.current \? " is-visible" : ""\}`\}/,
    "visibility must be a class toggle so the exit transition can play",
  );
});

test("floats the scroll-to-latest button above the composer, clear of the minimap", () => {
  const gate = source.indexOf("{!isEmptyNew && (");
  const marker = source.indexOf('className={`chat-scroll-to-bottom', gate);
  assert.notEqual(gate, -1);
  assert.notEqual(marker, -1);
  const container = source.slice(gate, marker);
  const block = elementBlock();

  assert.match(container, /position: "absolute"/);
  assert.match(container, /bottom: "100%"/);
  assert.match(container, /right: isMobile \? 0 : CHAT_MINIMAP_WIDTH/);
  assert.match(container, /justifyContent: "center"/);
  assert.match(container, /pointerEvents: "none"/);
  assert.match(cssSource, /\.chat-scroll-to-bottom\.is-visible \{[\s\S]*?pointer-events: auto;/);
  assert.match(cssSource, /\.chat-scroll-to-bottom:focus-visible \{[\s\S]*?outline: 2px solid var\(--accent\)/);
  assert.match(block, /onClick=\{\(\) => scrollToBottom\("smooth"\)\}/);
});

test("keeps the visible button faint until hover or focus", () => {
  const hidden = cssSource.slice(cssSource.indexOf(".chat-scroll-to-bottom {"));
  const visible = hidden.slice(hidden.indexOf(".chat-scroll-to-bottom.is-visible {"));
  const reveal = hidden.slice(hidden.indexOf(".chat-scroll-to-bottom.is-visible:hover"));

  assert.match(visible.slice(0, visible.indexOf("}")), /opacity: 0\.28;[\s\S]*?visibility: visible;[\s\S]*?transform: none;/);
  assert.match(reveal.slice(0, reveal.indexOf("}")), /opacity: 1;/);
  assert.match(
    cssSource,
    /\.chat-scroll-to-bottom\.is-visible:hover,\s*\.chat-scroll-to-bottom\.is-visible:focus-visible \{[\s\S]*?opacity: 1;/,
  );
});

test("fades the button in and out without motion when motion is reduced", () => {
  const hidden = cssSource.slice(cssSource.indexOf(".chat-scroll-to-bottom {"));

  assert.match(hidden.slice(0, hidden.indexOf("}")), /opacity: 0;[\s\S]*?visibility: hidden;[\s\S]*?transform: translateY\(4px\) scale\(0\.96\);/);
  assert.match(hidden.slice(0, hidden.indexOf("}")), /transition:[\s\S]*?opacity 0\.16s ease,[\s\S]*?transform 0\.16s ease,[\s\S]*?visibility 0s linear 0\.16s;/);
  assert.match(
    cssSource,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-scroll-to-bottom,\s*\.chat-scroll-to-bottom\.is-visible \{\s*transform: none;\s*transition:\s*opacity 0\.16s ease,/,
  );
});

test("updates visibility inside the shared rAF scroll capture, not a new listener", () => {
  // 本地适配（共识）：可见性搭 ChatWindow 既有 rAF 节流 capture 的车，
  // 谓词与上游同源（lib/chat-lazy-load.shouldShowScrollToLatest）。
  assert.match(
    source,
    /const shouldShow = shouldShowScrollToLatest\(container\.scrollTop, container\.clientHeight, container\.scrollHeight\);\s*setShowScrollToLatest\(\(previous\) => \(previous === shouldShow \? previous : shouldShow\)\);/,
  );
  assert.match(source, /import \{[\s\S]*?shouldShowScrollToLatest,[\s\S]*?\} from "@\/lib\/chat-lazy-load";/);
  assert.match(lazyLoadSource, /export function shouldShowScrollToLatest\(/);
  // 点击走共享 scrollToBottom：内部 noteProgrammaticScroll 武装忽略窗，
  // 跟随重挂由 chat-scroll-follow 状态机自身近底转换完成（不旁路状态机）。
  assert.match(source, /onClick=\{\(\) => scrollToBottom\("smooth"\)\}/);
});
