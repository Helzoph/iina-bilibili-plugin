// 测试用的运行环境：用 node 实现 common.js 需要的 env，用内存对象模拟 IINA 的 mpv/core/menu
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// 真实环境：调用系统 curl/sh；@data/@tmp 映射到临时目录
function nodeEnv(prefs, opts) {
  opts = opts || {};
  const root = opts.root || fs.mkdtempSync(path.join(os.tmpdir(), "iina-bili-test-"));
  const dirs = { "@data/": path.join(root, "data") + "/", "@tmp/": path.join(root, "tmp") + "/" };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const resolve = (p) => {
    for (const k of Object.keys(dirs)) if (p.startsWith(k)) return dirs[k] + p.slice(k.length);
    return p;
  };
  const logs = [];
  return {
    root, logs, prefs,
    exec: opts.exec || ((file, args) => new Promise((res) => {
      execFile(file, args, { maxBuffer: 64 * 1024 * 1024, env: { LC_ALL: "en_US.UTF-8" } }, (err, stdout, stderr) => {
        res({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
      });
    })),
    pref: (k) => prefs[k],
    setPref: (k, v) => { prefs[k] = v; },
    read: (p) => (fs.existsSync(resolve(p)) ? fs.readFileSync(resolve(p), "utf8") : null),
    write: (p, c) => fs.writeFileSync(resolve(p), c),
    resolve: opts.resolve || resolve,
    log: (m) => logs.push(["log", m]),
    warn: (m) => logs.push(["warn", m]),
    error: (m) => logs.push(["error", m]),
  };
}

// 模拟 IINA API；mpv 属性保存在 props 里，命令记录在 commands 里。
// timers 只记录定时器，由测试调用 tick() 手动触发，不会让测试进程挂住
function fakeIina(prefs) {
  const props = {};
  const commands = [];
  const osds = [];
  const menuItems = [];
  const intervals = new Map();
  let timerId = 0;
  const timers = {
    setInterval: (fn, ms) => { intervals.set(++timerId, { fn, ms }); return timerId; },
    clearInterval: (id) => { intervals.delete(id); },
    active: () => intervals.size,
    tick: () => Promise.all([...intervals.values()].map((t) => t.fn())),
  };
  const item = (title, action, o) => ({ title, action, items: [], enabled: true, selected: false, ...(o || {}),
    addSubMenuItem(i) { this.items.push(i); return this; } });
  return {
    props, commands, osds, menuItems, timers,
    mpv: {
      getString: (k) => (props[k] === undefined ? "" : String(props[k])),
      getNumber: (k) => Number(props[k]),
      getFlag: (k) => !!props[k],
      getNative: (k) => props[k],
      set: (k, v) => { props[k] = v; },
      command: (name, args) => {
        commands.push([name].concat(args));
        // 只模拟带标签的 vf add/remove（@label:name=k=v），同标签的 add 替换原来的滤镜
        if (name === "vf") {
          const m = /^@(\w+)(?::(\w+)=(\w+)=(\S+))?$/.exec(args[1]);
          const list = (props.vf || []).filter((f) => f.label !== m[1]);
          if (args[0] === "add") list.push({ label: m[1], name: m[2], enabled: true, params: { [m[3]]: m[4] } });
          props.vf = list;
        }
      },
    },
    core: { osd: (m) => osds.push(m) },
    menu: {
      item, separator: () => item("-"),
      addItem: (i) => menuItems.push(i),
      removeAllItems: () => { menuItems.length = 0; },
      forceUpdate: () => {},
    },
    utils: { open: () => true },
    preferences: { get: (k) => prefs[k], set: (k, v) => { prefs[k] = v; }, sync: () => {} },
  };
}

// 离线环境：拦截 curl 与 sh，按 URL 正则返回预设内容；requests 记录每次请求的 URL、Referer 和是否带 Cookie。
// routes: [[正则, 返回值]]，返回值可以是字符串、对象（转为 JSON）、函数 (url, req) => 前两者，或 null 表示 curl 失败。
// 同一 URL 匹配多条时取第一条；值为数组时按调用次数依次返回，用完后重复最后一个
function mockEnv(prefs, routes, opts) {
  opts = opts || {};
  const requests = [];
  const counters = new Map();
  const env = nodeEnv(prefs, {
    exec: async (file, args) => {
      if (file === "/bin/sh") {
        const out = typeof opts.firefox === "function" ? opts.firefox(args) : opts.firefox;
        return out === null ? { status: 1, stdout: "", stderr: "boom" } : { status: 0, stdout: out || "", stderr: "" };
      }
      const url = args[args.length - 1];
      const at = args.indexOf("-H");
      const headerFile = args.find((a, i) => args[i - 1] === "-H" && a.startsWith("@"));
      const req = {
        url, args,
        head: args.includes("-I"),
        referer: at >= 0 ? args[at + 1].replace(/^Referer: /, "") : null,
        cookie: headerFile ? fs.readFileSync(headerFile.slice(1), "utf8").replace(/^Cookie: /, "").trim() : null,
      };
      requests.push(req);
      const route = routes.find((r) => r[0].test(url));
      if (!route) return { status: 22, stdout: "", stderr: "no route " + url };
      let value = route[1];
      if (Array.isArray(value)) {
        const n = counters.get(route) || 0;
        counters.set(route, n + 1);
        value = value[Math.min(n, value.length - 1)];
      }
      if (typeof value === "function") value = value(url, req);
      if (value === null) return { status: 7, stdout: "", stderr: "connect failed" };
      return { status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" };
    },
  });
  env.requests = requests;
  // 模拟 IINA 的数据目录位置（~/Library/Application Support/...），用于测试从中推导主目录
  if (opts.home !== undefined) {
    const base = env.resolve;
    env.resolve = (p) => (p === "@data/" ? opts.home + "/Library/Application Support/com.colliderli.iina/plugins/.data/x/" : base(p));
  }
  return env;
}

module.exports = { nodeEnv, fakeIina, mockEnv };
