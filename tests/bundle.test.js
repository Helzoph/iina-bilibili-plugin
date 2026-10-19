"use strict";

// 在隔离的 vm 上下文里运行打包后的 dist/index.js，模拟 IINA 注入的全局 iina 对象，验证入口的注册逻辑
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");
const { fakeIina } = require("./harness");

const ROOT = path.join(__dirname, "..");

function run() {
  execFileSync(process.execPath, [path.join(ROOT, "build.js")], { cwd: ROOT });
  const code = fs.readFileSync(path.join(ROOT, "dist", "index.js"), "utf8");
  const fake = fakeIina({ cookie_source: "none" });
  const hooks = [];
  const events = {};
  const logs = [];
  const forceUpdates = [];
  // 与 IINA 1.5.0 一致：loadFile 会清空已注册的 onMessage
  const sidebar = {
    loads: [], listeners: {}, posted: [],
    loadFile(p) { this.loads.push(p); this.listeners = {}; },
    onMessage(name, cb) { this.listeners[name] = cb; },
    postMessage(name, data) { this.posted.push([name, data]); },
    show() {},
  };
  const opened = [];
  const iina = {
    ...fake,
    core: { ...fake.core, open: (url) => opened.push(url) },
    menu: { ...fake.menu, forceUpdate: () => forceUpdates.push(Date.now()) },
    mpv: { ...fake.mpv, addHook: (name, priority, cb) => hooks.push({ name, priority, cb }) },
    event: { on: (name, cb) => { events[name] = cb; } },
    sidebar,
    file: { exists: () => false, read: () => null, write: () => {} },
    utils: { ...fake.utils, exec: async () => ({ status: 1, stdout: "", stderr: "" }), resolvePath: (p) => "/tmp/" + p },
    console: { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  };
  vm.runInNewContext(code, { iina, Promise, JSON, Date, Math, Number, String, Object, Array, Set, Map, RegExp, Error });
  return { iina: fake, hooks, events, logs, code, forceUpdates, sidebar, opened };
}

test("打包产物以 on_load 优先级 5 注册异步钩子", () => {
  const { hooks } = run();
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].name, "on_load");
  assert.equal(hooks[0].priority, 5);
  // IINA 依据构造器名判断钩子是否异步，打包时不能被转译成普通函数
  assert.equal(hooks[0].cb.constructor.name, "AsyncFunction");
});

test("打包产物监听文件加载与轨道变化事件，并建立菜单", () => {
  const { events, iina } = run();
  assert.deepEqual(Object.keys(events).sort(), [
    "iina.file-loaded", "iina.window-loaded", "mpv.aid.changed", "mpv.end-file", "mpv.secondary-sid.changed", "mpv.sid.changed", "mpv.vid.changed",
  ]);
  assert.equal(iina.menuItems.length, 1);
  assert.equal(iina.menuItems[0].title, "Bilibili");
});

// IINA 1.5.0 在 PlayerCore.first 的一次性初始化里执行插件脚本，此时 forceUpdate 会重入该初始化导致进程崩溃
test("打包产物在加载阶段不调用 menu.forceUpdate", async () => {
  const { forceUpdates } = run();
  // 登录状态检查可能在脚本执行结束前的微任务里完成，一并等待
  await new Promise((r) => setImmediate(r));
  assert.equal(forceUpdates.length, 0);
});

test("窗口加载完成后才刷新菜单", async () => {
  const { events, forceUpdates } = run();
  await new Promise((r) => setImmediate(r));
  events["iina.window-loaded"]();
  assert.equal(forceUpdates.length, 1);
});

test("窗口加载完成后载入侧边栏页面，网页 ready 后收到状态，并能回传操作", async () => {
  const { events, sidebar } = run();
  await new Promise((r) => setImmediate(r));
  assert.equal(sidebar.loads.length, 0);
  events["iina.window-loaded"]();
  assert.deepEqual(sidebar.loads, ["sidebar/index.html"]);
  sidebar.listeners.ready(1);
  const state = JSON.parse(decodeURIComponent(sidebar.posted.at(-1)[1]));
  assert.equal(state.item, null);
  assert.equal(state.login, "未登录（设置中已关闭登录）");
  sidebar.listeners.action({ type: "codec", name: "avc" });
  assert.equal(JSON.parse(decodeURIComponent(sidebar.posted.at(-1)[1])).codec, "avc");
});

test("侧边栏的浏览操作由浏览模块处理，结果以 list 消息发回网页", async () => {
  const { events, sidebar, logs } = run();
  events["iina.window-loaded"]();
  await sidebar.listeners.action({ type: "browse", kind: "popular" });
  const lists = sidebar.posted.filter(([name]) => name === "list").map(([, d]) => JSON.parse(decodeURIComponent(d)));
  assert.deepEqual(lists.map((v) => [v.kind, v.loading]), [["popular", true], ["popular", false]]);
  assert.ok(!logs.some((m) => /未知的侧边栏操作/.test(m)));
});

test("Info.json 声明的侧边栏页面存在", () => {
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, "Info.json"), "utf8"));
  assert.equal(info.sidebarTab.name, "Bilibili");
  assert.ok(fs.existsSync(path.join(ROOT, require("../src/sidebar").PAGE)));
});

test("钩子处理非 B 站链接后调用 next", async () => {
  const { hooks, iina } = run();
  iina.props["stream-open-filename"] = "/tmp/a.mp4";
  let called = 0;
  await hooks[0].cb(() => called++);
  assert.equal(called, 1);
  assert.equal(iina.props["stream-open-filename"], "/tmp/a.mp4");
});

test("钩子在解析出错时仍然调用 next，避免播放卡住", async () => {
  const { hooks, iina, logs } = run();
  iina.props["stream-open-filename"] = "https://www.bilibili.com/video/BV1xx411c7mD";
  let called = 0;
  await hooks[0].cb(() => called++);
  assert.equal(called, 1);
  assert.ok(iina.osds.some((m) => m.startsWith("B 站链接解析失败")));
  assert.ok(logs.length > 0);
});

test("打包产物与 Info.json 的入口和默认设置一致", () => {
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, "Info.json"), "utf8"));
  const { DEFAULTS } = require("../src/common");
  assert.equal(info.entry, "dist/index.js");
  assert.deepEqual(info.preferenceDefaults, DEFAULTS);
  // 设置页里的每个 data-pref-key 都要有默认值
  const html = fs.readFileSync(path.join(ROOT, info.preferencesPage), "utf8");
  const keys = new Set([...html.matchAll(/data-pref-key="(\w+)"/g)].map((m) => m[1])
    .concat([...html.matchAll(/name="(\w+)"[^>]*data-pref-key/g)].map((m) => m[1])));
  for (const k of keys) assert.ok(k in DEFAULTS, k);
});
