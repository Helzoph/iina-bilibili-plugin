// IINA 插件入口（每个播放器窗口各运行一份）
"use strict";

const { createBili } = require("./common");
const { createParser } = require("./parser");
const { createPlayer } = require("./player");
const { createSidebarBridge } = require("./sidebar");
const { createBrowser } = require("./browse");

const { mpv, core, menu, utils, preferences, file, event, sidebar, console } = iina;

const env = {
  exec: (f, args) => utils.exec(f, args),
  pref: (key) => preferences.get(key),
  setPref: (key, value) => preferences.set(key, value),
  read: (path) => (file.exists(path) ? file.read(path) : null),
  write: (path, content) => file.write(path, content),
  resolve: (path) => utils.resolvePath(path),
  log: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

const bili = createBili(env);
const side = createSidebarBridge(sidebar, (msg) => console.warn("[bilibili] " + msg));
const parser = createParser(bili);
const player = createPlayer({
  mpv, core, menu, utils, preferences, onState: side.onState, showSidebar: side.show,
}, bili, parser);
// core.open 在当前窗口打开链接，随后照常经过下面的 on_load 钩子解析
const browser = createBrowser({ parser, bili, open: (url) => core.open(url), onState: side.onList });

// mpv 按优先级从小到大执行钩子；Online Media 插件在 on_load 用 10 处理 ytdl://，在 on_load_fail 处理普通网址，
// 这里用更小的值抢先接管 B 站链接。IINA 依据函数是否为 AsyncFunction 决定是否等待，必须手动调用 next
mpv.addHook("on_load", 5, async (next) => {
  try {
    await player.onLoad();
  } catch (e) {
    console.error("[bilibili] " + (e && e.stack || e));
  }
  next();
});

event.on("iina.window-loaded", () => {
  side.load((msg) => browser.handleAction(msg) || player.handleAction(msg));
  player.onWindowLoaded();
});
event.on("iina.file-loaded", () => player.onFileLoaded());
event.on("mpv.end-file", () => player.onEndFile());
event.on("mpv.vid.changed", () => player.onTrackChanged("video"));
event.on("mpv.aid.changed", () => player.onTrackChanged("audio"));
event.on("mpv.sid.changed", () => player.onTrackChanged("sub"));
event.on("mpv.secondary-sid.changed", () => player.onTrackChanged("sub"));

player.buildMenu();
player.updateLoginLabel(false).then(() => player.buildMenu(), (e) => console.error("[bilibili] " + e));
