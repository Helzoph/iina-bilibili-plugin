// 播放控制：接管 B 站链接的加载，把解析结果交给 mpv，并维护“插件 > Bilibili”菜单。
// api 为 IINA 的 { mpv, core, menu, utils, preferences } 或测试中的同构替身；
// 可选的 api.onState(snapshot) 在状态变化时被调用（用于侧边栏），api.showSidebar 存在时菜单里提供“显示侧边栏”
"use strict";

const { REFERER, LIVE_REFERER, UA, DEFAULTS, str, isBilibiliUrl } = require("./common");
const { videoEdl, playlistM3u, ccToSrt } = require("./media");
const { toAss } = require("./danmaku");

const DANMAKU_TITLE = "弹幕";
// 离结尾不到这么多秒就算看完，下次从头播放。看完时上报的是最后一次采样的位置（最多早 5 秒），总在这个范围里
const FINISHED_MARGIN = 30;
const PROGRESS_SAMPLE_MS = 5000;
const PROGRESS_STEP = 15;
// 预加载：真实剩余时间（按播放速度折算）不到这么多秒时准备下一项；本文件至少播放这么多次检查间隔后才开始，免得和起播抢带宽
const PRELOAD_LEAD = 60;
const PRELOAD_CHECK_MS = 5000;
const PRELOAD_WARMUP_CHECKS = 2;
// 播放地址约两小时过期，预加载的结果放久了就不用
const PRELOAD_TTL = 30 * 60 * 1000;
// 流畅弹幕：mpv 只在视频出新帧时重画字幕，用 fps 滤镜把帧重复到屏幕刷新率，弹幕就按刷新率移动。
// 屏幕刷新率未知时按 60，最高 120，免得高刷屏上为 4K 视频多做太多合成
const SMOOTH_LABEL = "bilidm";
const SMOOTH_DEFAULT_FPS = 60;
const SMOOTH_MAX_FPS = 120;
const CODEC_NAMES = { hevc: "HEVC (H.265)", avc: "AVC (H.264)", av1: "AV1" };

// 侧边栏可调的弹幕样式：键名 -> [首选项, 把网页传来的值转成首选项的值，不合法时返回 undefined]
const range = (min, max, round) => (v) => (typeof v === "number" && Number.isFinite(v)
  ? Math.min(max, Math.max(min, round ? Math.round(v) : v)) : undefined);
const DANMAKU_STYLE = {
  font: ["danmaku_font", (v) => (typeof v === "string" ? v.replace(/[,\r\n]/g, "").trim().slice(0, 100) : undefined)],
  fontSize: ["danmaku_font_size", range(10, 200, true)],
  opacity: ["danmaku_opacity", range(0, 1)],
  displayArea: ["danmaku_display_area", range(0.1, 1)],
  scrollTime: ["danmaku_scroll_time", range(1, 60)],
  bold: ["danmaku_bold", (v) => (typeof v === "boolean" ? v : undefined)],
};

function clock(t) {
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(t / 3600);
  return (h ? h + ":" + pad(Math.floor(t / 60) % 60) : Math.floor(t / 60)) + ":" + pad(t % 60);
}

function createPlayer(api, bili, parser) {
  const { mpv, core, menu, utils, preferences } = api;
  // 调用时才取全局的定时器函数，环境里没有时只影响进度上报，不影响插件加载
  const timers = api.timers || { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) };

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
    if (!bili.config().danmaku.enable || !info.cid) return null;
    const xml = await bili.httpGet(`https://comment.bilibili.com/${info.cid}.xml`, { cookie: false });
    if (!xml || !xml.includes("<i>")) {
      bili.warn("弹幕获取失败 cid=" + info.cid);
      return null;
    }
    return xml;
  }

  function danmakuAss(info, xml) {
    const { ass, count } = toAss(xml, info.width, info.height, bili.config().danmaku);
    bili.log(`弹幕 ${count} 条`);
    return ass;
  }

  // 播放器信息：CC/AI 字幕列表与登录账号上次的播放进度
  async function fetchPlayerInfo(info, wantProgress) {
    if ((!bili.config().subtitle.enable && !wantProgress) || !info.bvid || !info.cid) return null;
    return bili.api(`https://api.bilibili.com/x/player/v2?${info.aid ? "aid=" + info.aid + "&" : ""}bvid=${info.bvid}&cid=${info.cid}`);
  }

  // CC 字幕与 AI 字幕；未登录时接口通常不返回 AI 字幕
  async function fetchSubtitles(data) {
    if (!bili.config().subtitle.enable) return [];
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

  // 上次看到的位置（秒），只认同一个分 P / 同一集；快看完的不再续播。
  // 记录有两处：解析时 playurl / 剧集信息带回的（info.lastPlay）和 player/v2 的，取有进度的那条。
  // 返回 null 表示没拿到记录（未登录、请求失败），0 表示 B 站记录里不用续播
  function resumePosition(data, info) {
    const records = [info.lastPlay, data && data.last_play_time !== undefined
      ? { cid: data.last_play_cid, time: Number(data.last_play_time) } : null].filter(Boolean);
    for (const r of records) bili.log(`B 站播放记录：cid=${r.cid} ${Math.floor(r.time / 1000)}s（本集 cid=${info.cid}）`);
    const record = records.find((r) => r.time > 0) || records[0];
    if (!record) return null;
    const t = Math.floor(Number(record.time) / 1000);
    if (!(t > 0) || String(record.cid) !== String(info.cid)) return 0;
    return info.duration && t > info.duration - FINISHED_MARGIN ? 0 : t;
  }

  async function wantSync(info) {
    return bili.config().syncProgress && !!info.aid && !info.preview && !!(await bili.uid());
  }

  // preloaded 是预加载时已经发出的 player/v2 请求
  async function loadVideo(info, carry, preloaded) {
    info.sync = await wantSync(info);
    const playerInfo = preloaded || fetchPlayerInfo(info, info.sync);
    const [xml, subs, resume] = await Promise.all([
      fetchDanmaku(info), playerInfo.then(fetchSubtitles), playerInfo.then((data) => resumePosition(data, info)),
    ]);
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
    // IINA 1.5.0 的普通跳转在 B 站的流上偶尔只有声音、画面停住（iina/iina#6316），精确跳转不会
    setLocal("hr-seek", "yes");
    // 链接里的 t= 和重新加载时沿用的进度优先于上次的播放记录
    let from = carry.start !== undefined ? carry.start : info.start;
    if (from === undefined || from === null) {
      from = info.sync ? resume : null;
      if (from) info.resumed = from;
      // 拿到了 B 站的记录却不用续播时显式写 none，免得 IINA 自己记下的旧位置（watch_later）生效
      else if (from === 0) from = "none";
    }
    if (from) setLocal("start", String(from));
    applySmooth(smoothTarget(info, !!xml && bili.config().danmaku.show));

    if (xml) {
      // 弹幕也可能作为第二字幕与 CC 字幕同时显示，此时要保留 ASS 里的位置和动画
      setLocal("secondary-sub-ass-override", "no");
      mpv.command("sub-add", ["memory://" + danmakuAss(info, xml), "auto", DANMAKU_TITLE, "zh"]);
    }
    for (const s of subs) mpv.command("sub-add", ["memory://" + s.srt, "auto", s.title, s.lang]);
    info.hasDanmaku = !!xml;
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
      applySmooth(0);
      preload = null;
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
    let pre = null;
    let preResult = null;
    try {
      // 预加载还没完成时等它，不重复请求；预加载失败的照常再解析一次
      pre = await takePreload(carry.url ? "" : url);
      preResult = pre && await pre.ready;
      if (preResult) bili.log("使用预加载的解析结果");
      result = preResult || await parser.route(url, { liveQn: carry.liveQn });
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
    if (result.type !== "video") applySmooth(0);
    if (result.type === "list") {
      if (!result.items.length) {
        osd("没有可播放的内容");
        return;
      }
      mpv.set("stream-open-filename", playlistM3u(result.items));
      return;
    }
    if (result.type === "live") loadLive(result);
    else await loadVideo(result, carry, preResult && pre.playerInfo);
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

  // 修改样式时新旧两条弹幕轨会短暂共存，取最后加入的那条
  function danmakuTrack() {
    return tracks("sub").filter((t) => t.external && t.title === DANMAKU_TITLE).pop() || null;
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

  // ---------------------------------------------------------------- 流畅弹幕

  // 滤镜加在全局的 vf 上并带标签，换到下一个 B 站视频时目标不变就原样保留，不用重建滤镜链；
  // 打开其他文件或直播时在 on_load 里去掉，那时还没有建立滤镜链，没有额外开销。
  // IINA 退出时会把 vf 记进 watch_later，下次打开同一链接时也在 on_load 里纠正
  function smoothApplied() {
    const vf = mpv.getNative("vf");
    const f = Array.isArray(vf) ? vf.find((x) => x && x.label === SMOOTH_LABEL) : null;
    return f ? Number(f.params && f.params.fps) || -1 : 0;
  }

  function applySmooth(fps) {
    if (smoothApplied() === fps) return;
    if (fps) mpv.command("vf", ["add", `@${SMOOTH_LABEL}:fps=fps=${fps}`]);
    else mpv.command("vf", ["remove", "@" + SMOOTH_LABEL]);
    bili.log(fps ? `流畅弹幕：视频帧重复到 ${fps} fps` : "流畅弹幕：已停用");
  }

  // 显示弹幕且视频帧率低于屏幕刷新率时返回要补到的帧率，否则返回 0
  function smoothTarget(info, show) {
    if (!info || info.type !== "video" || !show || !bili.config().danmaku.smooth) return 0;
    const v = info.video[info === current && loaded ? selectedIndex("video") : info.videoIndex];
    // on_load 时 container-fps 还是上一个文件的
    const fps = (v && v.fps) || (loaded ? mpv.getNumber("container-fps") : 0);
    const display = Math.round(mpv.getNumber("display-fps"));
    const target = Math.min(SMOOTH_MAX_FPS, display > 0 ? display : SMOOTH_DEFAULT_FPS);
    // 59.94 之类和刷新率只差一点的不用补
    return fps > 0 && fps < target - 1 ? target : 0;
  }

  function updateSmooth() {
    if (!loaded || !current || current.type !== "video") return;
    applySmooth(smoothTarget(current, isDanmakuVisible()));
  }

  // 按当前样式重新生成弹幕并替换原来的轨道；正在显示时新轨道接替原来的位置（主字幕或第二字幕），不用重新加载视频
  // 弹幕 XML 不常驻内存（长视频可达数百 KB），修改样式时重新下载，只有最后一次修改会生效
  let restyleSeq = 0;
  async function restyleDanmaku() {
    const info = current;
    if (!info || !info.hasDanmaku) return;
    const seq = ++restyleSeq;
    const xml = await fetchDanmaku(info);
    // 下载期间换了视频或又改了样式
    if (current !== info || seq !== restyleSeq) return;
    const old = danmakuTrack();
    if (!xml || !old) {
      osd("弹幕样式已保存，重新获取弹幕失败，下次打开视频时生效");
      return;
    }
    const slot = ["sid", "secondary-sid"].find((p) => subId(p) === old.id);
    mpv.command("sub-add", ["memory://" + danmakuAss(info, xml), "auto", DANMAKU_TITLE, "zh"]);
    const dm = danmakuTrack();
    if (!dm || dm.id === old.id) return;
    if (slot) mpv.set(slot, String(dm.id));
    mpv.command("sub-remove", [String(old.id)]);
  }

  // 修改会被记住，之后打开的视频也按新样式显示
  async function setDanmakuStyle(msg) {
    if (msg.reset) {
      for (const [key] of Object.values(DANMAKU_STYLE)) savePref(key, DEFAULTS[key]);
    } else {
      const entry = DANMAKU_STYLE[msg.key];
      const value = entry && entry[1](msg.value);
      if (value === undefined) {
        bili.warn("无效的弹幕样式: " + msg.key);
        return;
      }
      if (bili.pref(entry[0]) === value) return;
      savePref(entry[0], value);
    }
    notify();
    await restyleDanmaku();
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

  // ---------------------------------------------------------------- 连播

  // 单独打开某一 P、合集里的某一集或番剧的某一集时，把后面的内容追加到播放列表，轮到时再解析。
  // 只在它是播放列表最后一项且不是从列表展开出来的（playlist-path 为空）时追加，
  // 列表页展开的条目和这里追加的条目都带 playlist-path，不会重复追加
  function appendFollowing() {
    const items = current.following;
    if (!bili.config().autoNext || !items || !items.length) return;
    const pos = mpv.getNumber("playlist-pos");
    if (!(pos >= 0) || pos !== mpv.getNumber("playlist-count") - 1) return;
    if (mpv.getString(`playlist/${pos}/playlist-path`)) return;
    mpv.command("loadlist", [playlistM3u(items), "append"]);
    bili.log(`已把后面的 ${items.length} 项加入播放列表`);
  }

  // ---------------------------------------------------------------- 预加载

  // 播放快结束时提前解析播放列表里的下一项，并让 CDN 把将要播放的那一档音视频提前缓存好，
  // 切换时省掉接口请求和 CDN 冷启动的等待。mpv 自带的 prefetch-playlist 用不上：它预取的是网页链接，
  // 在 on_load 里换成 EDL 后地址对不上会被丢弃；即使预先换好，它也会打开 EDL 里所有清晰度的轨道。
  // 只保留一份结果（几十 KB 的解析结果），下一次加载时用掉或丢弃；弹幕仍在播放时再取，不在内存里多留一份
  let preload = null;
  let preloadWatch = null;

  // 这些设置或登录状态变了，预加载时选的清晰度、编码、字幕和进度请求就不再适用
  function preloadKey(uid) {
    const cfg = bili.config();
    return JSON.stringify([cfg.video, cfg.syncProgress, cfg.subtitle.enable, uid]);
  }

  function nextEntry() {
    const pos = mpv.getNumber("playlist-pos");
    if (!(pos >= 0) || pos + 1 >= mpv.getNumber("playlist-count")) return "";
    return mpv.getString(`playlist/${pos + 1}/filename`);
  }

  function startPreload(url) {
    const entry = { url, time: Date.now(), key: null, playerInfo: null };
    preload = entry;
    bili.log("预加载下一项 " + url);
    entry.ready = (async () => {
      entry.key = preloadKey(await bili.uid());
      let result = null;
      try {
        result = await parser.route(url, {});
      } catch (e) {
        bili.warn("预加载失败: " + e);
      }
      if (!result || result.type !== "video") return null;
      entry.playerInfo = fetchPlayerInfo(result, await wantSync(result)).catch(() => null);
      const video = result.video[result.videoIndex];
      const audio = result.audio[result.audioIndex];
      for (const u of video ? [video.url, audio && audio.url] : [result.url]) {
        if (u) bili.warmUp(u);
      }
      return result;
    })().catch((e) => {
      bili.warn("预加载失败: " + e);
      return null;
    });
    return entry.ready;
  }

  // 取出与将要加载的链接对应、仍然有效的预加载结果；无论用不用，旧的结果都在这里丢掉
  async function takePreload(url) {
    const entry = preload;
    preload = null;
    if (!entry || entry.url !== url || Date.now() - entry.time > PRELOAD_TTL) return null;
    await entry.ready;
    return entry.key === preloadKey(await bili.uid()) ? entry : null;
  }

  function checkPreload(watch) {
    if (++watch.checks < PRELOAD_WARMUP_CHECKS || !current) return undefined;
    const url = nextEntry();
    // 每个文件对同一个下一项只尝试一次，拖回前面再看到结尾不会重复请求
    if (!url || url === watch.tried || !isBilibiliUrl(url) || /^https?:\/\/live\.bilibili\.com/i.test(url)) return undefined;
    const d = mpv.getNumber("duration");
    const duration = d > 0 ? d : current.duration;
    const speed = mpv.getNumber("speed") > 0 ? mpv.getNumber("speed") : 1;
    if (!(duration > 0) || (duration - position()) / speed > PRELOAD_LEAD) return undefined;
    watch.tried = url;
    return startPreload(url);
  }

  function startPreloadWatch() {
    stopPreloadWatch();
    if (!bili.config().preloadNext || current.type !== "video") return;
    const watch = { checks: 0, tried: "" };
    watch.timer = timers.setInterval(() => checkPreload(watch), PRELOAD_CHECK_MS);
    preloadWatch = watch;
  }

  function stopPreloadWatch() {
    if (!preloadWatch) return;
    timers.clearInterval(preloadWatch.timer);
    preloadWatch = null;
  }

  // ---------------------------------------------------------------- 播放进度

  // 登录后把进度报给 B 站，网页端的历史记录和其他设备的断点续播都能看到。
  // 每 5 秒记一次当前位置，比上次上报多走了 15 秒就上报；暂停、换视频、关闭窗口时立即上报。
  // 换视频时 mpv 已经卸载文件拿不到 time-pos，只能用最后一次记下的位置
  let progress = null;

  function sendProgress(info, pos) {
    return bili.csrf().then(async (csrf) => {
      if (!csrf) return;
      const text = await bili.httpPost("https://api.bilibili.com/x/v2/history/report", { aid: info.aid, cid: info.cid, progress: pos, csrf });
      let code;
      try {
        code = JSON.parse(text).code;
      } catch (e) {
        code = undefined;
      }
      if (code !== 0) bili.warn("播放进度上报失败: " + str(text).slice(0, 200));
      else bili.log(`播放进度 ${pos}s 已上报`);
    }).catch((e) => bili.warn("播放进度上报失败: " + e));
  }

  // 返回上报的 Promise，没有需要上报的内容时返回 undefined
  function reportProgress(pos, step) {
    if (!progress) return undefined;
    if (pos > 0) progress.pos = pos;
    pos = progress.pos;
    if (!(pos > 0) || Math.abs(pos - progress.sent) < (step || 1)) return undefined;
    progress.sent = pos;
    return sendProgress(progress.info, pos);
  }

  function startProgress(info) {
    stopProgress();
    if (!info.sync) return;
    const pos = position();
    progress = { info, pos, sent: pos, timer: timers.setInterval(() => reportProgress(position(), PROGRESS_STEP), PROGRESS_SAMPLE_MS) };
  }

  function stopProgress() {
    if (!progress) return;
    timers.clearInterval(progress.timer);
    progress = null;
  }

  function onPause() {
    if (loaded && mpv.getFlag("pause")) return reportProgress(position());
    return undefined;
  }

  function onWindowClose() {
    const sending = reportProgress(position());
    stopProgress();
    stopPreloadWatch();
    preload = null;
    return sending;
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

  function danmakuStyle() {
    const cfg = bili.config().danmaku;
    const out = {};
    for (const key of Object.keys(DANMAKU_STYLE)) out[key] = cfg[key];
    return out;
  }

  // 侧边栏需要的全部状态，只含可 JSON 序列化的值
  function snapshot() {
    const state = { login: loginLabel, codec: bili.pref("video_codec"), danmakuStyle: danmakuStyle(), loading, error: failure, item: null };
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
      case "danmakuStyle":
        return setDanmakuStyle(msg);
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
    // 两个方向都显式设置：IINA 的 watch_later 会恢复上次的 sid，关掉弹幕时也可能把弹幕打开
    if (current.hasDanmaku) setDanmaku(!!bili.config().danmaku.show);
    danmakuVisible = isDanmakuVisible();
    loaded = true;
    updateSmooth();
    if (current.resumed) osd("从上次看到的 " + clock(current.resumed) + " 继续播放");
    startProgress(current);
    appendFollowing();
    startPreloadWatch();
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
    // 换了清晰度帧率可能不同（如 1080P60）
    if (kind === "sub" || kind === "video") updateSmooth();
    buildMenu();
  }

  // 窗口移到刷新率不同的屏幕上
  function onDisplayFps() {
    updateSmooth();
  }

  function onEndFile() {
    loaded = false;
    const sending = reportProgress(0);
    stopProgress();
    stopPreloadWatch();
    return sending;
  }

  return {
    onLoad, onWindowLoaded, onFileLoaded, onTrackChanged, onDisplayFps, onEndFile, onPause, onWindowClose, buildMenu, updateLoginLabel,
    snapshot, handleAction,
    toggleDanmaku, setDanmakuStyle, selectVideo, selectAudio, selectLiveQuality, selectCodec,
    get current() { return current; },
  };
}

module.exports = { createPlayer, DANMAKU_TITLE };
