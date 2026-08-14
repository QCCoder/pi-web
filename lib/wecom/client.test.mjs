import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { WeComClient } = await jiti.import("./client.ts");

function fakeFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return { json: async () => response, statusText: "OK" };
  };
  return { fn, calls };
}

test("sendMarkdown: posts markdown body, returns ok on errcode 0", async () => {
  const { fn, calls } = fakeFetch({ errcode: 0, errmsg: "ok" });
  const client = new WeComClient("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K", fn);
  const result = await client.sendMarkdown("**hi**");
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.msgtype, "markdown");
  assert.equal(body.markdown.content, "**hi**");
});

test("sendText: posts text body", async () => {
  const { fn, calls } = fakeFetch({ errcode: 0, errmsg: "ok" });
  const client = new WeComClient("https://x?key=K", fn);
  await client.sendText("hello");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.msgtype, "text");
  assert.equal(body.text.content, "hello");
});

test("send: non-zero errcode => ok false with error", async () => {
  const { fn } = fakeFetch({ errcode: 93000, errmsg: "invalid webhook url" });
  const client = new WeComClient("https://x?key=bad", fn);
  const result = await client.sendMarkdown("x");
  assert.equal(result.ok, false);
  assert.match(result.error, /93000/);
});

test("send: network throw => ok false, no throw", async () => {
  const fn = async () => { throw new Error("ETIMEDOUT"); };
  const client = new WeComClient("https://x?key=K", fn);
  const result = await client.sendMarkdown("x");
  assert.equal(result.ok, false);
  assert.match(result.error, /ETIMEDOUT/);
});
