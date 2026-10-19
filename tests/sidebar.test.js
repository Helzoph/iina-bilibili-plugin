"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSidebarBridge, encodeState, PAGE } = require("../src/sidebar");

// 模拟 IINA 1.5.0 的 sidebar：loadFile 会清空已注册的 onMessage 监听；窗口未加载时 loadFile/show 抛出异常
function fakeSidebar(opts) {
  opts = opts || {};
  const listeners = {};
  const posted = [];
  const loads = [];
  let shown = 0;
  return {
    posted, loads, listeners,
    get shown() { return shown; },
    loadFile(path) {
      if (opts.windowMissing) throw new Error("window is not available");
      loads.push(path);
      for (const k of Object.keys(listeners)) delete listeners[k];
    },
    onMessage(name, cb) { listeners[name] = cb; },
    postMessage(name, data) {
      if (opts.postFails) throw new Error("webview gone");
      posted.push([name, data]);
    },
    show() {
      if (opts.windowMissing) throw new Error("window is not available");
      shown++;
    },
    // 模拟网页调用 window.iina.postMessage
    emit(name, data) { if (listeners[name]) listeners[name](data); },
  };
}

function decode(data) {
  return JSON.parse(decodeURIComponent(data));
}

test("encodeState 的结果不含会破坏 IINA 模板字符串的字符", () => {
  const state = { item: { title: "`反引号` ${x} \\ \"引号\" 【直播】" } };
  const out = encodeState(state);
  assert.doesNotMatch(out, /[`$\\"]/);
  assert.deepEqual(decode(out), state);
});

test("页面加载前收到的状态不会发送，加载后网页发 ready 时补发最新状态", () => {
  const sb = fakeSidebar();
  const bridge = createSidebarBridge(sb, () => {});
  bridge.onState({ n: 1 });
  bridge.onState({ n: 2 });
  assert.equal(sb.posted.length, 0);
  bridge.load(() => {});
  assert.deepEqual(sb.loads, [PAGE]);
  sb.emit("ready", 1);
  assert.equal(sb.posted.length, 1);
  assert.deepEqual(decode(sb.posted[0][1]), { n: 2 });
});

test("加载后状态变化会立即发送", () => {
  const sb = fakeSidebar();
  const bridge = createSidebarBridge(sb, () => {});
  bridge.load(() => {});
  bridge.onState({ n: 3 });
  assert.deepEqual(sb.posted.map(([name, d]) => [name, decode(d)]), [["state", { n: 3 }]]);
});

test("加载后还没有状态时 ready 不发送任何消息", () => {
  const sb = fakeSidebar();
  createSidebarBridge(sb, () => {}).load(() => {});
  sb.emit("ready", 1);
  assert.equal(sb.posted.length, 0);
});

test("网页的操作在 loadFile 之后注册，能转交给播放器", () => {
  const sb = fakeSidebar();
  const got = [];
  createSidebarBridge(sb, () => {}).load((msg) => got.push(msg));
  sb.emit("action", { type: "video", index: 1 });
  assert.deepEqual(got, [{ type: "video", index: 1 }]);
});

test("重复调用 load 只加载一次页面", () => {
  const sb = fakeSidebar();
  const bridge = createSidebarBridge(sb, () => {});
  bridge.load(() => {});
  bridge.load(() => {});
  assert.equal(sb.loads.length, 1);
  assert.ok(sb.listeners.action);
});

test("窗口不可用时 load 与 show 只记录日志", () => {
  const sb = fakeSidebar({ windowMissing: true });
  const logs = [];
  const bridge = createSidebarBridge(sb, (m) => logs.push(m));
  bridge.load(() => {});
  bridge.onState({ n: 1 });
  bridge.show();
  assert.equal(sb.posted.length, 0);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /侧边栏加载失败/);
  assert.match(logs[1], /无法显示侧边栏/);
});

test("发送失败时只记录日志", () => {
  const sb = fakeSidebar({ postFails: true });
  const logs = [];
  const bridge = createSidebarBridge(sb, (m) => logs.push(m));
  bridge.load(() => {});
  bridge.onState({ n: 1 });
  assert.match(logs[0], /侧边栏消息发送失败/);
});

test("show 打开侧边栏", () => {
  const sb = fakeSidebar();
  createSidebarBridge(sb, () => {}).show();
  assert.equal(sb.shown, 1);
});

test("浏览列表用单独的 list 消息发送，ready 时与播放状态一起补发", () => {
  const sb = fakeSidebar();
  const bridge = createSidebarBridge(sb, () => {});
  bridge.onList({ kind: "dynamic", items: [{ title: "`x` ${y}" }] });
  bridge.load(() => {});
  bridge.onState({ n: 1 });
  sb.posted.length = 0;
  sb.emit("ready", 1);
  assert.deepEqual(sb.posted.map(([name, d]) => [name, decode(d)]), [
    ["state", { n: 1 }],
    ["list", { kind: "dynamic", items: [{ title: "`x` ${y}" }] }],
  ]);
});

test("加载后浏览列表变化会立即发送，发送失败只记录日志", () => {
  const sb = fakeSidebar();
  const bridge = createSidebarBridge(sb, () => {});
  bridge.load(() => {});
  bridge.onList({ kind: "recommend" });
  assert.deepEqual(sb.posted.map(([name, d]) => [name, decode(d)]), [["list", { kind: "recommend" }]]);
  const bad = fakeSidebar({ postFails: true });
  const logs = [];
  const b2 = createSidebarBridge(bad, (m) => logs.push(m));
  b2.load(() => {});
  b2.onList({ kind: "recommend" });
  assert.match(logs[0], /侧边栏消息发送失败/);
});
