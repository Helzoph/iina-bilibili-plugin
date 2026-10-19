// 侧边栏浏览：按分类拉取推荐、关注的直播、动态等列表，点选后在当前窗口打开。
// 各分类直接复用 parser.route 已支持的 B 站页面链接；open(url) 为 IINA 的 core.open 或测试替身
"use strict";

const CATEGORIES = {
  recommend: "https://www.bilibili.com/",
  following: "https://link.bilibili.com/p/center/index",
  dynamic: "https://t.bilibili.com/",
  popular: "https://www.bilibili.com/v/popular/all",
  watchlater: "https://www.bilibili.com/list/watchlater",
  history: "https://www.bilibili.com/history",
  search: "https://search.bilibili.com/all?keyword=",
  searchLive: "https://search.bilibili.com/live?keyword=",
};
const SEARCH = { search: true, searchLive: true };
const LIVE_PREFIX = "【直播】";

// 切换分类时 5 分钟内直接用上次的结果，点“刷新”才重新请求
const CACHE_MS = 5 * 60 * 1000;

function categoryUrl(kind, keyword) {
  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, kind)) return null;
  if (!SEARCH[kind]) return CATEGORIES[kind];
  const k = String(keyword || "").trim();
  return k ? CATEGORIES[kind] + encodeURIComponent(k) : null;
}

// 只把网页需要的字段发过去；直播条目去掉标题前缀，改用 live 标记
function viewItem(it) {
  const title = String(it.title || "");
  const live = /^https?:\/\/live\.bilibili\.com\//.test(it.url);
  return {
    url: it.url,
    title: live && title.startsWith(LIVE_PREFIX) ? title.slice(LIVE_PREFIX.length) : title,
    author: it.author || "",
    duration: it.duration || null,
    cover: it.cover || "",
    live,
  };
}

function createBrowser({ parser, bili, open, onState, now }) {
  now = now || Date.now;
  const cache = {};
  let view = { kind: "", keyword: "", loading: false, error: "", items: [] };
  // 每次请求递增；旧请求返回时发现已不是最新的就丢弃
  let seq = 0;

  function emit() {
    if (!onState) return;
    try {
      onState(view);
    } catch (e) {
      bili.warn("侧边栏列表更新失败: " + e);
    }
  }

  async function browse(kind, keyword, refresh) {
    const url = categoryUrl(kind, keyword);
    if (!url) {
      bili.warn("无效的浏览分类: " + kind);
      return;
    }
    keyword = SEARCH[kind] ? String(keyword).trim() : "";
    const hit = cache[url];
    if (!refresh && hit && now() - hit.time < CACHE_MS) {
      seq++;
      view = { kind, keyword, loading: false, error: "", items: hit.items };
      emit();
      return;
    }
    const id = ++seq;
    view = { kind, keyword, loading: true, error: "", items: [] };
    emit();

    bili.state.lastError = "";
    let result = null;
    let error = "";
    try {
      result = await parser.route(url);
    } catch (e) {
      error = "获取失败: " + (e && e.message || e);
    }
    if (id !== seq) return;
    if (result && result.type === "list") {
      const items = result.items.map(viewItem);
      cache[url] = { items, time: now() };
      view = { kind, keyword, loading: false, error: "", items };
    } else {
      view = { kind, keyword, loading: false, error: error || bili.state.lastError || "获取失败", items: [] };
    }
    emit();
  }

  // 网页传回下标和链接，两者都要与当前列表一致才打开，防止列表已切换时打开错误的条目
  function play(index, url) {
    const it = view.items[index];
    if (!it || it.url !== url) return;
    try {
      open(it.url);
    } catch (e) {
      bili.warn("无法打开 " + it.url + ": " + e);
    }
  }

  // 返回 false 表示不是浏览相关的操作，交给播放器处理
  function handleAction(msg) {
    const type = msg && msg.type;
    if (type === "browse") return browse(msg.kind, msg.keyword, !!msg.refresh);
    if (type === "play") {
      play(Number(msg.index), msg.url);
      return true;
    }
    return false;
  }

  return { handleAction, get view() { return view; } };
}

module.exports = { createBrowser, categoryUrl, CATEGORIES, CACHE_MS };
