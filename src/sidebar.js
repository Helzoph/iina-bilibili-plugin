// 侧边栏桥接：把播放状态和浏览列表发给 sidebar/index.html，并把网页里的点击转回插件。
// sidebar 为 IINA 的 iina.sidebar 或测试中的替身
"use strict";

const PAGE = "sidebar/index.html";

// IINA 把字符串原样拼进网页里的模板字符串（window.iina._emit(`name`, `"…"`)），
// 标题里的反引号、${、反斜杠都会破坏这段脚本，所以先编码成只含 URL 安全字符的字符串
function encodeState(state) {
  return encodeURIComponent(JSON.stringify(state));
}

function createSidebarBridge(sidebar, log) {
  let loaded = false;
  // 最近一次的播放状态（state）与浏览列表（list），网页重新索取时补发
  const latest = { state: null, list: null };

  function send(name) {
    if (!loaded || !latest[name]) return;
    try {
      sidebar.postMessage(name, encodeState(latest[name]));
    } catch (e) {
      log("侧边栏消息发送失败: " + e);
    }
  }

  function resend() {
    send("state");
    send("list");
  }

  // 只能在 iina.window-loaded 之后调用。loadFile 会清空已注册的 onMessage，监听必须在它之后注册。
  // 同一实例只加载一次：网页加载好后会主动发 ready 来索取当前状态
  function load(onAction) {
    if (loaded) return;
    try {
      sidebar.loadFile(PAGE);
    } catch (e) {
      log("侧边栏加载失败: " + e);
      return;
    }
    loaded = true;
    sidebar.onMessage("ready", resend);
    sidebar.onMessage("action", (msg) => onAction(msg));
  }

  function onState(state) {
    latest.state = state;
    send("state");
  }

  function onList(view) {
    latest.list = view;
    send("list");
  }

  function show() {
    try {
      sidebar.show();
    } catch (e) {
      log("无法显示侧边栏: " + e);
    }
  }

  return { load, onState, onList, show };
}

module.exports = { createSidebarBridge, encodeState, PAGE };
