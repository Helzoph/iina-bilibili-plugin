// 播放控制：接管 B 站链接的加载，把解析结果交给 mpv，并维护“插件 > Bilibili”菜单。
// api 为 IINA 的 { mpv, core, menu, utils, preferences } 或测试中的同构替身；
// 可选的 api.onState(snapshot) 在状态变化时被调用（用于侧边栏），api.showSidebar 存在时菜单里提供“显示侧边栏”
"use strict";

const { REFERER, LIVE_REFERER, UA, str, isBilibiliUrl } = require("./common");
const { videoEdl, playlistM3u, ccToSrt } = require("./media");
const { toAss } = require("./danmaku");

const DANMAKU_TITLE = "弹幕";
const CODEC_NAMES = { hevc: "HEVC (H.265)", avc: "AVC (H.264)", av1: "AV1" };

function createPlayer(api, bili, parser) {
  const { mpv, core, menu, utils, preferences } = api;

  // 当前正在播放的 B 站内容；next 是重新加载时要沿用的状态（起播位置、清晰度等）
  let current = null;
  let next = null;
  let loaded = false;
  let danmakuVisible = null;
  // 正在解析的链接与上一次解析失败的原因，只用于侧边栏展示
  let loading = false;
  let failure = "";

  function osd(msg) {
    try {
      core.osd(msg);
    } catch (e) {
      // 窗口尚未加载时无法显示 OSD
    }
  }

  function savePref(key, value) {
    preferences.set(key, value);
    if (preferences.sync) preferences.sync();
  }

  // ---------------------------------------------------------------- 加载

  async function fetchDanmaku(info) {
    const cfg = bili.config().danmaku;
    if (!cfg.enable || !info.cid) return null;
    const xml = await bili.httpGet(`https://comment.bilibili.com/${info.cid}.xml`, { cookie: false });
    if (!xml || !xml.includes("<i>")) {
      bili.warn("弹幕获取失败 cid=" + info.cid);
      return null;
    }
    const { ass, count } = toAss(xml, info.width, info.height, cfg);
    bili.log(`弹幕 ${count} 条`);
    return ass;
  }

  // CC 字幕与 AI 字幕；未登录时接口通常不返回 AI 字幕
  async function fetchSubtitles(info) {
    if (!bili.config().subtitle.enable || !info.bvid || !info.cid) return [];
    const data = await bili.api(`https://api.bilibili.com/x/player/v2?bvid=${info.bvid}&cid=${info.cid}`);
    const subs = (data && data.subtitle && data.subtitle.subtitles) || [];
    const out = [];
    for (const sub of subs) {
      const url = str(sub.subtitle_url).startsWith("//") ? "https:" + sub.subtitle_url : sub.subtitle_url;
      if (!url) continue;
      let obj = null;
      try {
        obj = JSON.parse(await bili.httpGet(url, { cookie: false }));
      } catch (e) {
        obj = null;
      }
      if (obj && Array.isArray(obj.body)) out.push({ title: sub.lan_doc || sub.lan, lang: sub.lan, srt: ccToSrt(obj) });
    }
    return out;
  }

  function setLocal(name, value) {
    mpv.set("file-local-options/" + name, value);
  }

  async function loadVideo(info, carry) {
    const [ass, subs] = await Promise.all([fetchDanmaku(info), fetchSubtitles(info)]);
    if (carry.qn) {
      const i = info.video.findIndex((v) => v.qn === carry.qn);
      if (i >= 0) info.videoIndex = i;
    }
    if (carry.audioId) {
      const i = info.audio.findIndex((a) => a.id === carry.audioId);
      if (i >= 0) info.audioIndex = i;
    }

    if (info.video.length) {
      mpv.set("stream-open-filename", videoEdl(info));
      // EDL 里轨道按顺序编号，从 1 开始
      setLocal("vid", String(info.videoIndex + 1));
      if (info.audio.length) setLocal("aid", String(info.audioIndex + 1));
    } else {
      mpv.set("stream-open-filename", info.url);
    }
    setLocal("http-header-fields", ["Referer: " + REFERER]);
    setLocal("user-agent", UA);
    setLocal("force-media-title", info.title || "");
    const start = carry.start !== undefined ? carry.start : info.start;
    if (start) setLocal("start", String(start));

    if (ass) {
      // 弹幕也可能作为第二字幕与 CC 字幕同时显示，此时要保留 ASS 里的位置和动画
      setLocal("secondary-sub-ass-override", "no");
      mpv.command("sub-add", ["memory://" + ass, "auto", DANMAKU_TITLE, "zh"]);
    }
    for (const s of subs) mpv.command("sub-add", ["memory://" + s.srt, "auto", s.title, s.lang]);
    info.hasDanmaku = !!ass;
    info.subtitleCount = subs.length;
  }

  function loadLive(info) {
    mpv.set("stream-open-filename", info.url);
    setLocal("http-header-fields", ["Referer: " + LIVE_REFERER]);
    setLocal("user-agent", UA);
    setLocal("force-media-title", info.title || "");
  }

  async function onLoad() {
    const url = mpv.getString("stream-open-filename");
    if (!isBilibiliUrl(url)) {
      current = null;
      next = null;
      loading = false;
      failure = "";
      return;
    }
    const carry = next && next.url === url ? next : {};
    next = null;
    current = null;
    loaded = false;
    danmakuVisible = null;
    bili.state.lastError = "";
    loading = true;
    failure = "";
    notify();
    osd("正在解析 B 站链接…");

    let result;
    try {
      result = await parser.route(url, { liveQn: carry.liveQn });
    } catch (e) {
      bili.fail("解析出错: " + (e && e.stack || e), "解析出错: " + e);
      result = null;
    }
    loading = false;
    if (!result) {
      failure = bili.state.lastError || "解析失败";
      notify();
      // 不修改地址，加载失败后 Online Media 插件（yt-dlp）还有机会接手
      osd("B 站链接解析失败" + (bili.state.lastError ? "：" + bili.state.lastError : ""));
      return;
    }
    if (result.type === "list") {
      if (!result.items.length) {
        osd("没有可播放的内容");
        return;
      }
      mpv.set("stream-open-filename", playlistM3u(result.items));
      return;
    }
    if (result.type === "live") loadLive(result);
    else await loadVideo(result, carry);
    current = Object.assign({ pageUrl: url }, result);
    if (result.preview) osd("仅能播放试看片段，完整观看需要登录有权限的账号");
  }

  // 重新加载当前条目；state 会在下一次解析同一链接时沿用
  function reload(state) {
    if (!current) return;
    next = Object.assign({ url: current.pageUrl }, state);
    mpv.command("playlist-play-index", ["current"]);
  }

  function position() {
    const t = mpv.getNumber("time-pos");
    return Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
  }

  // ---------------------------------------------------------------- 轨道

  function tracks(type) {
    const list = mpv.getNative("track-list") || [];
    return list.filter((t) => t.type === type);
  }

  // 视频/音频轨道 id 与解析结果的下标一一对应（EDL 内的轨道按顺序编号）
  function selectedIndex(type) {
    const id = Number(mpv.getString(type === "video" ? "vid" : "aid"));
    return Number.isFinite(id) && id > 0 ? id - 1 : -1;
  }

  function danmakuTrack() {
    return tracks("sub").find((t) => t.external && t.title === DANMAKU_TITLE) || null;
  }

  function subId(prop) {
    const v = Number(mpv.getString(prop));
    return Number.isFinite(v) ? v : 0;
  }

  function isDanmakuVisible() {
    const dm = danmakuTrack();
    return !!dm && (subId("sid") === dm.id || subId("secondary-sid") === dm.id);
  }

  // 显示弹幕时如果正在显示其他字幕（如 CC 字幕），把弹幕放到第二字幕，两者同时显示
  function setDanmaku(show) {
    const dm = danmakuTrack();
    if (!dm) return false;
    const sid = subId("sid");
    if (show) {
      if (sid && sid !== dm.id) mpv.set("secondary-sid", String(dm.id));
      else mpv.set("sid", String(dm.id));
    } else {
      if (sid === dm.id) mpv.set("sid", "no");
      if (subId("secondary-sid") === dm.id) mpv.set("secondary-sid", "no");
    }
    return true;
  }

  function selectVideo(i) {
    if (!current || !current.video || !current.video[i]) return;
    mpv.set("vid", String(i + 1));
    osd("清晰度：" + current.video[i].name);
  }

  // 选择会被记住：选的是当前最高档时记为“不设上限”，之后遇到更清晰的视频不会被锁在这一档
  function rememberVideo(i) {
    const v = current.video[i];
    savePref("max_quality", String(i === 0 ? 127 : v.qn));
  }

  function selectAudio(i) {
    if (!current || !current.audio || !current.audio[i]) return;
    mpv.set("aid", String(i + 1));
    osd("音质：" + current.audio[i].name);
  }

  function selectLiveQuality(qn) {
    if (!current || current.type !== "live" || qn === current.qn) return;
    savePref("live_quality", String(qn));
    osd("正在切换直播清晰度…");
    reload({ liveQn: qn });
  }

  function selectCodec(name) {
    if (bili.pref("video_codec") === name) return;
    savePref("video_codec", name);
    if (!current || current.type !== "video" || !current.video.length) {
      buildMenu();
      return;
    }
    osd("正在切换编码：" + CODEC_NAMES[name]);
    const v = current.video[Math.max(0, selectedIndex("video"))];
    const a = current.audio[selectedIndex("audio")];
    reload({ start: position(), qn: v && v.qn, audioId: a && a.id });
  }

  // ---------------------------------------------------------------- 菜单

  // IINA 1.5.0 在 PlayerCore.first 的一次性初始化里执行插件脚本，此时 forceUpdate 会重入该初始化导致崩溃，
  // 所以窗口或文件加载完成前只构建菜单项，不刷新
  let menuReady = false;

  function buildMenu() {
    menu.removeAllItems();
    const root = menu.item("Bilibili");
    if (!current) {
      root.addSubMenuItem(menu.item("当前没有在播放 B 站内容", null, { enabled: false }));
    } else if (current.type === "live") {
      const q = menu.item("直播清晰度");
      for (const item of current.qualities) {
        q.addSubMenuItem(menu.item(item.name, () => selectLiveQuality(item.qn), { selected: item.qn === current.qn }));
      }
      if (current.qualities.length <= 1) q.addSubMenuItem(menu.item("登录后可解锁更多清晰度", null, { enabled: false }));
      root.addSubMenuItem(q);
    } else {
      const vi = selectedIndex("video");
      const q = menu.item("清晰度");
      current.video.forEach((v, i) => {
        q.addSubMenuItem(menu.item(v.name, () => { selectVideo(i); rememberVideo(i); }, { selected: i === vi }));
      });
      if (!current.video.length) q.addSubMenuItem(menu.item("只有一种清晰度", null, { enabled: false }));
      root.addSubMenuItem(q);

      if (current.audio.length > 1) {
        const ai = selectedIndex("audio");
        const a = menu.item("音质");
        current.audio.forEach((t, i) => a.addSubMenuItem(menu.item(t.name, () => selectAudio(i), { selected: i === ai })));
        root.addSubMenuItem(a);
      }

      const c = menu.item("视频编码偏好");
      const pick = bili.pref("video_codec");
      for (const name of ["hevc", "avc", "av1"]) {
        c.addSubMenuItem(menu.item(CODEC_NAMES[name], () => selectCodec(name), { selected: pick === name }));
      }
      root.addSubMenuItem(c);

      root.addSubMenuItem(menu.item(current.hasDanmaku ? "显示弹幕" : "显示弹幕（没有弹幕）", toggleDanmaku, {
        enabled: !!current.hasDanmaku, selected: isDanmakuVisible(), keyBinding: "Meta+d",
      }));
    }
    root.addSubMenuItem(menu.separator());
    if (current) {
      root.addSubMenuItem(menu.item("刷新播放地址", () => reload({ start: position() })));
      root.addSubMenuItem(menu.item("在浏览器中打开", () => utils.open(current.web)));
    }
    if (api.showSidebar) root.addSubMenuItem(menu.item("显示侧边栏", () => api.showSidebar()));
    root.addSubMenuItem(menu.item("登录状态：" + loginLabel, null, { enabled: false }));
    root.addSubMenuItem(menu.item("重新读取登录信息", refreshLogin));
    menu.addItem(root);
    if (menuReady) menu.forceUpdate();
    notify();
  }

  // ---------------------------------------------------------------- 侧边栏

  // 侧边栏需要的全部状态，只含可 JSON 序列化的值
  function snapshot() {
    const state = { login: loginLabel, codec: bili.pref("video_codec"), loading, error: failure, item: null };
    if (!current) return state;
    const item = { type: current.type, url: current.pageUrl, title: current.title || "", author: current.author || "" };
    if (current.type === "live") {
      item.qualities = current.qualities.map((q) => ({ qn: q.qn, name: q.name }));
      item.qn = current.qn;
    } else {
      item.video = current.video.map((v) => ({ name: v.name, height: v.height || null, fps: v.fps || null }));
      item.videoIndex = selectedIndex("video");
      item.audio = current.audio.map((a) => ({ name: a.name }));
      item.audioIndex = selectedIndex("audio");
      item.hasDanmaku = !!current.hasDanmaku;
      item.danmaku = isDanmakuVisible();
    }
    state.item = item;
    return state;
  }

  function notify() {
    if (!api.onState) return;
    try {
      api.onState(snapshot());
    } catch (e) {
      bili.warn("侧边栏更新失败: " + e);
    }
  }

  // 侧边栏发来的操作；msg 来自网页，字段类型不可信
  function handleAction(msg) {
    const type = msg && msg.type;
    const index = Number(msg && msg.index);
    switch (type) {
      case "video":
        if (current && current.video && current.video[index]) {
          selectVideo(index);
          rememberVideo(index);
        }
        return;
      case "audio":
        return selectAudio(index);
      case "live":
        return selectLiveQuality(Number(msg.qn));
      case "codec":
        if (CODEC_NAMES[msg.name]) selectCodec(msg.name);
        return;
      case "danmaku":
        return toggleDanmaku();
      case "reload":
        return reload({ start: position() });
      case "open":
        if (current) utils.open(current.web);
        return;
      case "login":
        return refreshLogin();
      default:
        bili.warn("未知的侧边栏操作: " + type);
    }
  }

  function onWindowLoaded() {
    menuReady = true;
    buildMenu();
  }

  let loginLabel = "检查中…";
  async function updateLoginLabel(refresh) {
    const source = bili.pref("cookie_source");
    const cookie = await bili.userCookie(refresh);
    const m = cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/);
    const from = source === "firefox" ? "Firefox" : source === "manual" ? "手动填写" : "";
    loginLabel = m ? `已登录（${from}，UID ${m[1]}）` : source === "none" ? "未登录（设置中已关闭登录）" : `未登录（${from}）`;
  }

  async function refreshLogin() {
    await updateLoginLabel(true);
    osd(loginLabel);
    buildMenu();
  }

  function toggleDanmaku() {
    const show = !isDanmakuVisible();
    if (!setDanmaku(show)) {
      osd("当前内容没有弹幕");
      return;
    }
    savePref("danmaku_show", show);
    osd(show ? "弹幕：开" : "弹幕：关");
  }

  // ---------------------------------------------------------------- 事件

  function onFileLoaded() {
    menuReady = true;
    if (!current) {
      buildMenu();
      return;
    }
    if (current.hasDanmaku && bili.config().danmaku.show) setDanmaku(true);
    danmakuVisible = isDanmakuVisible();
    loaded = true;
    buildMenu();
  }

  // 在 IINA 原生的“视频轨道”菜单里切换清晰度同样会被记住；弹幕在原生字幕菜单里开关也一样
  function onTrackChanged(kind) {
    if (!loaded || !current) return;
    if (kind === "video" && current.type === "video") {
      const i = selectedIndex("video");
      if (current.video[i]) rememberVideo(i);
    }
    if (kind === "sub" && current.hasDanmaku) {
      const visible = isDanmakuVisible();
      if (visible !== danmakuVisible) {
        danmakuVisible = visible;
        savePref("danmaku_show", visible);
      }
    }
    buildMenu();
  }

  function onEndFile() {
    loaded = false;
  }

  return {
    onLoad, onWindowLoaded, onFileLoaded, onTrackChanged, onEndFile, buildMenu, updateLoginLabel,
    snapshot, handleAction,
    toggleDanmaku, selectVideo, selectAudio, selectLiveQuality, selectCodec,
    get current() { return current; },
  };
}

module.exports = { createPlayer, DANMAKU_TITLE };
