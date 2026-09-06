import test from "node:test";
import assert from "node:assert/strict";

/**
 * 键盘 reveal 平移补偿公式测试。三组用例对应三类内核的真实形态：
 * ① Chromium resizes-visual：只有 vvTop 量得到（2026-09-05 Android Chrome/Edge 151
 *    真机日志：vvTop=262, vis=367, live=682, scrollY=0, htmlTop=0）
 * ② iOS scroll 型：rect 与 vvTop 同时报告同一偏移 —— MAX 而非 SUM（防双重补偿）
 * ③ iOS content-inset 型：只有 rect 量得到（scrollY/offsetTop 都读 0）
 */
async function loadSubject() {
  return import("./keyboard-layout.ts");
}

test("① Chromium vv-pan 内核：只有 vvTop 报告平移 → 用 vvTop", async () => {
  const { computeKeyboardLift } = await loadSubject();
  // 真机日志原值
  assert.equal(computeKeyboardLift(0, 262), 262);
  // 平移中途（键盘动画未完）
  assert.equal(computeKeyboardLift(0, 140), 140);
});

test("② iOS scroll 型：rect 与 vvTop 报告同一偏移 → 取 max 不求和", async () => {
  const { computeKeyboardLift } = await loadSubject();
  // html 被顶起 180（rect.top=-180），vvTop 也读到 180 —— 必须是 180 不是 360
  assert.equal(computeKeyboardLift(-180, 180), 180);
});

test("③ iOS content-inset 型：只有 rect 量得到 → 用 -htmlTop", async () => {
  const { computeKeyboardLift } = await loadSubject();
  assert.equal(computeKeyboardLift(-180, 0), 180);
});

test("无平移（resizes-content 内核应用已对齐 / 键盘刚关）→ 0", async () => {
  const { computeKeyboardLift } = await loadSubject();
  assert.equal(computeKeyboardLift(0, 0), 0);
});

test("信号为负（html 低于视口顶，如余量）不产生负补偿", async () => {
  const { computeKeyboardLift } = await loadSubject();
  assert.equal(computeKeyboardLift(20, 0), 0);
  assert.equal(computeKeyboardLift(-0.4, 0.2), 0);
});

test("④ VirtualKeyboard 路径：boundingRect.top 即真实可视高度（绕过浏览器高估）", async () => {
  const { computeVkKeyboardState } = await loadSubject();
  // 真机场景：窗口 682，vis 报 367（高估遮挡），键盘真实顶边 423（vk.top）
  assert.deepEqual(computeVkKeyboardState({ top: 423, height: 259 }, 682), {
    open: true,
    visibleHeight: 423,
  });
});

test("④ vk 键盘关闭（height=0）→ 不压缩，回到布局高", async () => {
  const { computeVkKeyboardState } = await loadSubject();
  assert.deepEqual(computeVkKeyboardState({ top: 0, height: 0 }, 682), {
    open: false,
    visibleHeight: 682,
  });
});

test("④ vk 怪矩形（top≤0）退回 live-height", async () => {
  const { computeVkKeyboardState } = await loadSubject();
  assert.deepEqual(computeVkKeyboardState({ top: 0, height: 300 }, 682), {
    open: true,
    visibleHeight: 382,
  });
});

// ---- resolveKeyboardStrategy：键盘开启态的布局策略分治 ----

test("策略 ① Edge/Chrome resizes-visual（2026-09-06 真机：live=682 不缩、vis=367）→ native", async () => {
  const { resolveKeyboardStrategy } = await loadSubject();
  assert.deepEqual(resolveKeyboardStrategy(682, 682, 367, true), { mode: "native", appHeight: 682 });
});

test("策略 ① iOS Safari（布局视口不缩、vv 缩）→ native", async () => {
  const { resolveKeyboardStrategy } = await loadSubject();
  assert.deepEqual(resolveKeyboardStrategy(734, 734, 402, true), { mode: "native", appHeight: 734 });
});

test("策略 ② 布局视口自己缩（微信 XWeb：live 682→400）→ squeeze 到可视高", async () => {
  const { resolveKeyboardStrategy } = await loadSubject();
  assert.deepEqual(resolveKeyboardStrategy(682, 400, 400, true), {
    mode: "squeeze",
    appHeight: 400,
  });
});

test("策略 ② 无 vv 老内核（X5：clientHeight 不缩、innerHeight 缩）→ squeeze", async () => {
  const { resolveKeyboardStrategy } = await loadSubject();
  assert.deepEqual(resolveKeyboardStrategy(682, 682, 400, false), {
    mode: "squeeze",
    appHeight: 400,
  });
});

test("策略：尚无基准（baseline=0）按 live 处理 → Edge 形态仍判 native", async () => {
  const { resolveKeyboardStrategy } = await loadSubject();
  assert.deepEqual(resolveKeyboardStrategy(0, 682, 367, true), { mode: "native", appHeight: 682 });
});

test("策略：vis 收缩未达键盘阈值（工具栏折叠量级）→ squeeze 兜底（实际流程不可达：钩子的 kb 判据不会放行）", async () => {
  const { resolveKeyboardStrategy } = await loadSubject();
  assert.deepEqual(resolveKeyboardStrategy(682, 682, 560, true), {
    mode: "squeeze",
    appHeight: 560,
  });
});

test("策略 ③ vk overlaysContent（hasVv=false 化）→ squeeze（浏览器不管布局，必须自压）", async () => {
  const { resolveKeyboardStrategy } = await loadSubject();
  assert.deepEqual(resolveKeyboardStrategy(682, 682, 423, false), {
    mode: "squeeze",
    appHeight: 423,
  });
});
