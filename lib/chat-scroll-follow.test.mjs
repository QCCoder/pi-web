import test from "node:test";
import assert from "node:assert/strict";

/**
 * 聊天流式跟随决策测试。模拟器复刻 useAgentSession 的真实事件序列：
 * 流式增量（内容长高）→ 跟随帧决策 → 贴底（scrollIntoView + 忽略窗 + scroll 事件），
 * 用户输入（wheel/touch）→ 意图刷新 → scroll 事件。
 * “被拽回底部”（shouldFollowStream=true 且用户已上滑）就是用户报告的抖动。
 */
async function loadSubject() {
  return import("./chat-scroll-follow.ts");
}

function makeChat({ subject, clientHeight = 800, t0 = 0 } = {}) {
  const { createScrollFollowState, noteUserScrollIntent, handleScrollEvent, shouldFollowStream, noteProgrammaticScroll } = subject;
  const state = createScrollFollowState();
  const chat = {
    state,
    t: t0,
    scrollTop: 0,
    scrollHeight: 1600,
    clientHeight,
    /** wheel 事件 → scroll 事件 */
    _userScroll(dy, dt) {
      chat.t += dt;
      noteUserScrollIntent(state, chat.t);
      chat.scrollTop -= dy;
      handleScrollEvent(state, chat.scrollTop, chat.scrollHeight - chat.scrollTop - chat.clientHeight, chat.t);
    },
    wheel(dy, dt = 16) {
      chat._userScroll(dy, dt);
    },
    touchstart(dt = 16) {
      chat.t += dt;
      noteUserScrollIntent(state, chat.t);
    },
    touchmove(dy, dt = 16) {
      chat._userScroll(dy, dt);
    },
    fireScroll() {
      handleScrollEvent(state, chat.scrollTop, chat.scrollHeight - chat.scrollTop - chat.clientHeight, chat.t);
    },
    /** 程序化贴底（scrollIntoView instant）*/
    pin(dt = 0) {
      chat.t += dt;
      noteProgrammaticScroll(state, chat.t);
      chat.scrollTop = chat.scrollHeight - chat.clientHeight;
      chat.fireScroll();
    },
    /** 流式增量：内容长高；返回本帧是否把视口拽回底部 */
    stream({ grow = 40, dt = 200 } = {}) {
      chat.t += dt;
      chat.scrollHeight += grow;
      const followed = shouldFollowStream(state, chat.scrollHeight - chat.scrollTop - chat.clientHeight, chat.t);
      if (followed) chat.pin();
      return followed;
    },
  };
  return chat;
}

async function makeHarness(opts = {}) {
  return makeChat({ subject: await loadSubject(), ...opts });
}

test("流式期间小幅上滑（滚轮刻度，<120px 近底带）立即停跟随", async () => {
  const chat = await makeHarness();
  chat.pin(); // 初始贴底
  assert.ok(chat.stream(), "贴底状态下流式增量正常跟随");

  chat.wheel(60); // 用户上滑 60px：一个滚轮刻度，仍在 120px 近底带内
  assert.equal(chat.state.allowed, false, "近底带内的用户上滑必须停跟随");
  assert.ok(!chat.stream(), "小幅上滑后流式增量不得再拽回底部（抖动拉锯）");
});

test("慢速上滑（每事件 2px：慢触控板/高刷触屏）也能停跟随", async () => {
  const chat = await makeHarness();
  chat.pin();
  assert.ok(chat.stream());

  for (let i = 0; i < 5; i++) chat.wheel(2); // 每事件 2px，累计 10px
  assert.equal(chat.state.allowed, false, "单事件小 delta 的连续上滑必须停跟随");
  assert.ok(!chat.stream());
});

test("长按拖动（touchmove 持续刷新意图）全程不被拽回", async () => {
  const chat = await makeHarness();
  chat.pin();
  assert.ok(chat.stream());

  chat.touchstart();
  let yankedMidDrag = false;
  for (let i = 0; i < 80; i++) {
    chat.touchmove(3, 30); // 拖 2.4s：意图窗口靠 touchmove 持续刷新（1.2s 窗口不能中途过期）
    if (i % 10 === 9 && chat.stream()) yankedMidDrag = true;
  }
  assert.ok(!yankedMidDrag, "拖动过程中流式增量不得恢复跟随（中途意图过期即抖动）");
  assert.equal(chat.state.allowed, false);
});

test("滚回底部恢复跟随（停跟随的逃生通道）", async () => {
  const chat = await makeHarness();
  chat.pin();
  assert.ok(chat.stream());
  chat.wheel(300); // 上滑 300px 停跟随
  assert.equal(chat.state.allowed, false);
  assert.ok(!chat.stream());
  assert.ok(!chat.stream());

  chat.t += 2000; // 意图早已过期，纯用户滚回底部
  chat.scrollTop = chat.scrollHeight - chat.clientHeight;
  chat.fireScroll();
  assert.equal(chat.state.allowed, true, "滚回底部附近恢复跟随");
  assert.ok(chat.stream(), "恢复后继续跟随流式增量");
});

test("停跟随后流式增量永不贴底", async () => {
  const chat = await makeHarness();
  chat.pin();
  chat.stream();
  chat.wheel(200);
  assert.equal(chat.state.allowed, false);
  for (let i = 0; i < 5; i++) assert.ok(!chat.stream());
});

test("无用户意图的布局收缩（流式重排变矮）不停跟随", async () => {
  const chat = await makeHarness();
  chat.pin();
  chat.scrollHeight -= 6; // 无任何 wheel/touch：纯布局收缩把 scrollTop 顶小
  chat.fireScroll();
  assert.equal(chat.state.allowed, true, "无意图的 scrollTop 减小不得停跟随");
  assert.ok(chat.stream());
});

test("程序化贴底自身的 scroll 事件保持跟随开启", async () => {
  const chat = await makeHarness();
  chat.pin();
  chat.pin();
  assert.equal(chat.state.allowed, true);
  assert.ok(chat.stream());
});

test("用户在近底带来回微滚：向上即停、回底即恢复", async () => {
  const chat = await makeHarness();
  chat.pin();
  chat.stream();
  chat.wheel(30); // 上 30px
  assert.equal(chat.state.allowed, false);
  chat.scrollTop += 30; // 滚回底部
  chat.fireScroll();
  assert.equal(chat.state.allowed, true);
});

test("无输入佐语的持续上滑（滚动条/最小地图长拖，意图已过期）不得拉锯", async () => {
  const chat = await makeHarness();
  chat.pin();
  chat.stream();
  // 抓住开始上拖：pointerdown 只给一次意图，拖动本身不再派发 wheel/touch 事件
  chat.wheel(30); // 意图触发 + 上滑停跟随
  assert.equal(chat.state.allowed, false);
  chat.t += 1500; // 拖动超过 1.2s：意图过期，但手指还按在滚动条/最小地图上
  let yanked = 0;
  for (let i = 0; i < 40; i++) {
    chat.scrollTop -= 1; // 每帧继续上拖 1px（累计仍在近底带内）
    chat.fireScroll();
    if (chat.stream({ grow: 1, dt: 50 })) yanked++; // 流式增量持续到达
  }
  assert.equal(yanked, 0, "拖动未停稳前流式增量不得拽回底部（拉锯抖动）");
  assert.equal(chat.state.allowed, false);
});

test("抬指后的惯性上滚（touchmove 已停，近底带内）不得被流式增量拽回", async () => {
  const chat = await makeHarness();
  chat.pin();
  chat.stream();
  chat.touchstart();
  for (let i = 0; i < 25; i++) chat.touchmove(2, 30); // 手指拖 50px，仍在带内
  assert.equal(chat.state.allowed, false);
  chat.t += 1300; // 抬指后动量持续 >1.2s：只剩 scroll 事件，输入事件不再来
  let yanked = 0;
  for (let i = 0; i < 20; i++) {
    chat.t += 30;
    chat.scrollTop -= 1; // 惯性继续上滚（仍在带内）
    chat.fireScroll();
    if (chat.stream({ grow: 0, dt: 0 })) yanked++; // 稀疏增量到达（思考间隙）
  }
  assert.equal(yanked, 0, "惯性未停稳前流式增量不得拽回底部");
});

test("停稳后向下滚回底部（无新输入事件，scrollTop 增大）恢复跟随", async () => {
  const chat = await makeHarness();
  chat.pin();
  chat.stream();
  chat.wheel(200);
  chat.t += 1500; // 意图过期
  // 向下惯性：只有 scroll 事件，scrollTop 逐帧增大直到贴底
  for (let i = 0; i < 40; i++) {
    chat.scrollTop += 10;
    chat.fireScroll();
  }
  assert.equal(chat.state.allowed, true, "向下滚回底部的 scroll 事件必须恢复跟随");
  assert.ok(chat.stream());
});

test("贴底滚动作用于聊天容器本身，不再经文档层 sentinel（upstream be428cf）", async () => {
  // scrollToBottom 的真实落点（useAgentSession）：sentinel 的 scrollIntoView 会
  // 向上冒泡到每一层可滚动祖先——移动端键盘顶起文档层时，流式跟随每帧都在滚
  // 动文档层，整个应用可见跳动。改为直接 container.scrollTo。
  const { readFile } = await import("node:fs/promises");
  const sessionSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  const start = sessionSource.indexOf("const scrollToBottom = useCallback");
  const end = sessionSource.indexOf("const markUserScrollIntent");
  assert.ok(start !== -1 && end > start, "scrollToBottom 定义存在");
  const scrollToBottomSource = sessionSource.slice(start, end);
  assert.match(scrollToBottomSource, /const container = scrollContainerRef\.current;\s*if \(!container\) return;/);
  assert.match(scrollToBottomSource, /container\.scrollTo\(\{ top: container\.scrollHeight, behavior \}\);/);
  assert.doesNotMatch(scrollToBottomSource, /scrollIntoView/);
  // sentinel 已整体退役：ref 与渲染节点都不再存在
  assert.doesNotMatch(sessionSource, /messagesEndRef/);
  assert.doesNotMatch(chatWindowSource, /messagesEndRef/);
});
