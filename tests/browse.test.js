"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowser, categoryUrl, CACHE_MS } = require("../src/browse");

const video = (n) => ({ url: "https://www.bilibili.com/video/BV" + n, title: "视频" + n, author: "UP", duration: 61, cover: "https://i0.hdslb.com/" + n + ".jpg" });
const live = (n) => ({ url: "https://live.bilibili.com/" + n, title: "【直播】房间" + n, author: "主播" });

// routes: url → 结果或 (url) => 结果；未列出的链接返回 null
function setup(routes, opts) {
  opts = opts || {};
  const bili = {
    state: { lastError: "" },
    warns: [],
    warn(m) { this.warns.push(m); },
    fail(m, short) { this.state.lastError = short || m; },
  };
  const requested = [];
  const parser = {
    async route(url) {
      requested.push(url);
      const r = routes[url];
      if (typeof r === "function") return r(url);
      if (r === undefined) bili.state.lastError = "该功能需要登录 B 站";
      return r === undefined ? null : r;
    },
  };
  const opened = [];
  const states = [];
  let now = 1000;
  const browser = createBrowser({
    parser, bili,
    open: (url) => opened.push(url),
    onState: opts.noState ? undefined : (s) => states.push(JSON.parse(JSON.stringify(s))),
    now: () => now,
  });
  return { browser, bili, requested, opened, states, last: () => states[states.length - 1], tick: (ms) => { now += ms; } };
}

const list = (items) => ({ type: "list", items });

test("categoryUrl 把分类映射到 parser 已支持的 B 站页面", () => {
  assert.equal(categoryUrl("recommend"), "https://www.bilibili.com/");
  assert.equal(categoryUrl("following"), "https://link.bilibili.com/p/center/index");
  assert.equal(categoryUrl("dynamic"), "https://t.bilibili.com/");
  assert.equal(categoryUrl("popular"), "https://www.bilibili.com/v/popular/all");
  assert.equal(categoryUrl("search", "原神 4K"), "https://search.bilibili.com/all?keyword=%E5%8E%9F%E7%A5%9E%204K");
  assert.equal(categoryUrl("searchLive", "lol"), "https://search.bilibili.com/live?keyword=lol");
});

test("categoryUrl 对未知分类和空关键字返回 null", () => {
  assert.equal(categoryUrl("nope"), null);
  assert.equal(categoryUrl("toString"), null);
  assert.equal(categoryUrl("search", "  "), null);
  assert.equal(categoryUrl("search"), null);
});

test("browse 先发送加载中，再发送列表；条目带 live 标记且不含多余字段", async () => {
  const ctx = setup({ "https://t.bilibili.com/": list([video(1), live(2)]) });
  await ctx.browser.handleAction({ type: "browse", kind: "dynamic" });
  assert.deepEqual(ctx.states[0], { kind: "dynamic", keyword: "", loading: true, error: "", items: [] });
  assert.deepEqual(ctx.last(), {
    kind: "dynamic", keyword: "", loading: false, error: "",
    items: [
      { url: video(1).url, title: "视频1", author: "UP", duration: 61, cover: video(1).cover, live: false },
      { url: live(2).url, title: "房间2", author: "主播", duration: null, cover: "", live: true },
    ],
  });
});

test("browse 失败时显示 parser 给出的原因", async () => {
  const ctx = setup({});
  await ctx.browser.handleAction({ type: "browse", kind: "following" });
  assert.equal(ctx.last().loading, false);
  assert.equal(ctx.last().error, "该功能需要登录 B 站");
});

test("browse 在 parser 抛出异常时显示错误而不是一直加载", async () => {
  const ctx = setup({ "https://www.bilibili.com/": () => { throw new Error("boom"); } });
  await ctx.browser.handleAction({ type: "browse", kind: "recommend" });
  assert.equal(ctx.last().loading, false);
  assert.match(ctx.last().error, /boom/);
});

test("browse 对不是列表的结果和空列表给出提示", async () => {
  const ctx = setup({
    "https://www.bilibili.com/": { type: "video" },
    "https://www.bilibili.com/v/popular/all": list([]),
  });
  await ctx.browser.handleAction({ type: "browse", kind: "recommend" });
  assert.equal(ctx.last().error, "获取失败");
  await ctx.browser.handleAction({ type: "browse", kind: "popular" });
  assert.equal(ctx.last().error, "");
  assert.deepEqual(ctx.last().items, []);
});

test("browse 不会把上一次播放失败的原因当成这次的错误", async () => {
  const ctx = setup({ "https://www.bilibili.com/": { type: "video" } });
  ctx.bili.state.lastError = "旧错误";
  await ctx.browser.handleAction({ type: "browse", kind: "recommend" });
  assert.equal(ctx.last().error, "获取失败");
});

test("browse 在缓存有效期内切回同一分类不重新请求，refresh 或过期后重新请求", async () => {
  const ctx = setup({ "https://www.bilibili.com/": list([video(1)]), "https://t.bilibili.com/": list([video(2)]) });
  await ctx.browser.handleAction({ type: "browse", kind: "recommend" });
  await ctx.browser.handleAction({ type: "browse", kind: "dynamic" });
  await ctx.browser.handleAction({ type: "browse", kind: "recommend" });
  assert.equal(ctx.requested.length, 2);
  assert.equal(ctx.last().items[0].title, "视频1");
  await ctx.browser.handleAction({ type: "browse", kind: "recommend", refresh: true });
  assert.equal(ctx.requested.length, 3);
  ctx.tick(CACHE_MS + 1);
  await ctx.browser.handleAction({ type: "browse", kind: "recommend" });
  assert.equal(ctx.requested.length, 4);
});

test("browse 失败的结果不缓存", async () => {
  const ctx = setup({});
  await ctx.browser.handleAction({ type: "browse", kind: "following" });
  await ctx.browser.handleAction({ type: "browse", kind: "following" });
  assert.equal(ctx.requested.length, 2);
});

test("browse 先后切换两个分类时，较慢的旧结果不会覆盖新结果", async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const ctx = setup({
    "https://www.bilibili.com/": () => slow.then(() => list([video(1)])),
    "https://t.bilibili.com/": list([video(2)]),
  });
  const first = ctx.browser.handleAction({ type: "browse", kind: "recommend" });
  await ctx.browser.handleAction({ type: "browse", kind: "dynamic" });
  release();
  await first;
  assert.equal(ctx.last().kind, "dynamic");
  assert.equal(ctx.last().items[0].title, "视频2");
});

test("browse 搜索时去掉关键字首尾空白，视频与直播分别缓存", async () => {
  const ctx = setup({
    "https://search.bilibili.com/all?keyword=lol": list([video(1)]),
    "https://search.bilibili.com/live?keyword=lol": list([live(2)]),
  });
  await ctx.browser.handleAction({ type: "browse", kind: "search", keyword: " lol " });
  assert.equal(ctx.last().keyword, "lol");
  await ctx.browser.handleAction({ type: "browse", kind: "searchLive", keyword: "lol" });
  assert.equal(ctx.last().items[0].live, true);
  assert.equal(ctx.requested.length, 2);
});

test("browse 对未知分类和空关键字只记录警告", async () => {
  const ctx = setup({});
  await ctx.browser.handleAction({ type: "browse", kind: "constructor" });
  await ctx.browser.handleAction({ type: "browse", kind: "search", keyword: "" });
  assert.equal(ctx.requested.length, 0);
  assert.equal(ctx.states.length, 0);
  assert.equal(ctx.bili.warns.length, 2);
});

test("play 按下标打开当前列表里的链接", async () => {
  const ctx = setup({ "https://t.bilibili.com/": list([video(1), live(2)]) });
  await ctx.browser.handleAction({ type: "browse", kind: "dynamic" });
  ctx.browser.handleAction({ type: "play", index: 1, url: live(2).url });
  assert.deepEqual(ctx.opened, ["https://live.bilibili.com/2"]);
});

test("play 在下标越界或与列表不一致（列表已切换）时不打开任何链接", async () => {
  const ctx = setup({ "https://t.bilibili.com/": list([video(1)]) });
  ctx.browser.handleAction({ type: "play", index: 0, url: video(1).url });
  await ctx.browser.handleAction({ type: "browse", kind: "dynamic" });
  ctx.browser.handleAction({ type: "play", index: 5, url: video(1).url });
  ctx.browser.handleAction({ type: "play", index: "x" });
  ctx.browser.handleAction({ type: "play", index: 0, url: "https://evil.example/" });
  assert.deepEqual(ctx.opened, []);
});

test("handleAction 只处理浏览相关的操作，其他操作返回 false", async () => {
  const ctx = setup({ "https://t.bilibili.com/": list([video(1)]) });
  assert.equal(ctx.browser.handleAction({ type: "video", index: 0 }), false);
  assert.equal(ctx.browser.handleAction(null), false);
  assert.ok(ctx.browser.handleAction({ type: "browse", kind: "dynamic" }));
});

test("没有 onState 时 browse 正常完成", async () => {
  const ctx = setup({ "https://t.bilibili.com/": list([video(1)]) }, { noState: true });
  await ctx.browser.handleAction({ type: "browse", kind: "dynamic" });
  ctx.browser.handleAction({ type: "play", index: 0, url: video(1).url });
  assert.deepEqual(ctx.opened, [video(1).url]);
});

test("onState 抛出异常时只记录警告", async () => {
  const bili = { state: { lastError: "" }, warns: [], warn(m) { this.warns.push(m); } };
  const browser = createBrowser({
    parser: { route: async () => list([video(1)]) }, bili, open: () => {},
    onState: () => { throw new Error("webview gone"); },
  });
  await browser.handleAction({ type: "browse", kind: "recommend" });
  assert.match(bili.warns[0], /webview gone/);
});

test("open 抛出异常（链接不被允许等）时只记录警告", async () => {
  const bili = { state: { lastError: "" }, warns: [], warn(m) { this.warns.push(m); } };
  const browser = createBrowser({
    parser: { route: async () => list([video(1)]) }, bili, open: () => { throw new Error("not allowed"); },
  });
  await browser.handleAction({ type: "browse", kind: "recommend" });
  browser.handleAction({ type: "play", index: 0, url: video(1).url });
  assert.match(bili.warns[0], /not allowed/);
});
