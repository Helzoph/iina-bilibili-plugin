"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBili, REFERER, LIVE_REFERER, UA } = require("../src/common");
const { createParser } = require("../src/parser");
const { createPlayer, DANMAKU_TITLE } = require("../src/player");
const F = require("./fixtures");
const { mockEnv, fakeIina } = require("./harness");
const fs = require("fs");

const VIDEO_URL = "https://www.bilibili.com/video/BV1xx411c7mD?t=30";
const VIDEO_ROUTES = [
  [/web-interface\/view/, F.VIEW_SINGLE],
  [/player\/playurl/, F.PLAYURL],
  [/comment\.bilibili\.com/, F.DANMAKU_XML],
  [/player\/v2/, F.PLAYER_V2],
  [/aisubtitle/, F.CC_JSON],
  [/finger\/spi/, { code: 0, data: { b_3: "B3" } }],
];
const LIVE_ROUTES = [
  [/getRoomBaseInfo/, F.ROOM_BASE],
  [/getRoomPlayInfo/, F.ROOM_PLAY],
  [/\/live\//, "200"],
];

// prefs 同时作为 IINA 首选项和 env.pref 的存储，便于验证 player 写入的偏好会被解析器读到
function setup(prefs, routes) {
  prefs = Object.assign({ cookie_source: "none" }, prefs);
  const iina = fakeIina(prefs);
  const env = mockEnv(prefs, routes || VIDEO_ROUTES);
  const bili = createBili(env);
  const player = createPlayer(iina, bili, createParser(bili));
  return { iina, env, bili, player, prefs };
}

// 模拟 mpv 打开 EDL 后的轨道列表：4 条视频、3 条音频、弹幕与 CC 字幕
function loadTracks(iina) {
  const subs = iina.commands.filter((c) => c[0] === "sub-add");
  iina.props["track-list"] = [
    ...[1, 2, 3, 4].map((id) => ({ id, type: "video" })),
    ...[1, 2, 3].map((id) => ({ id, type: "audio" })),
    ...subs.map((c, i) => ({ id: i + 1, type: "sub", external: true, title: c[3] })),
  ];
  iina.props.vid = iina.props["file-local-options/vid"];
  iina.props.aid = iina.props["file-local-options/aid"];
  iina.props.sid = "no";
  iina.props["secondary-sid"] = "no";
}

async function open(ctx, url) {
  ctx.iina.props["stream-open-filename"] = url;
  await ctx.player.onLoad();
  loadTracks(ctx.iina);
  ctx.player.onFileLoaded();
}

// 在菜单树里按标题路径查找条目
function find(iina, ...path) {
  let items = iina.menuItems;
  let node = null;
  for (const title of path) {
    node = items.find((i) => i.title === title || i.title.startsWith(title));
    if (!node) return null;
    items = node.items;
  }
  return node;
}

// ---------------------------------------------------------------- 加载

test("onLoad 忽略非 B 站链接", async () => {
  const ctx = setup();
  ctx.iina.props["stream-open-filename"] = "/Users/me/movie.mkv";
  await ctx.player.onLoad();
  assert.equal(ctx.iina.props["stream-open-filename"], "/Users/me/movie.mkv");
  assert.equal(ctx.env.requests.length, 0);
  assert.equal(ctx.player.current, null);
});

test("onLoad 把视频替换为 EDL 并设置请求头、标题、起播位置与默认轨道", async () => {
  const ctx = setup({ max_quality: "80" });
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  const p = ctx.iina.props;
  assert.match(p["stream-open-filename"], /^edl:\/\/!new_stream;/);
  assert.equal(p["file-local-options/vid"], "2");
  assert.equal(p["file-local-options/aid"], "1");
  assert.deepEqual(p["file-local-options/http-header-fields"], ["Referer: " + REFERER]);
  assert.equal(p["file-local-options/user-agent"], UA);
  assert.equal(p["file-local-options/force-media-title"], "测试视频");
  assert.equal(p["file-local-options/start"], "30");
  assert.equal(ctx.player.current.pageUrl, VIDEO_URL);
  assert.deepEqual(ctx.iina.osds, ["正在解析 B 站链接…"]);
});

test("onLoad 加载弹幕与 CC 字幕轨道", async () => {
  const ctx = setup();
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  const subs = ctx.iina.commands.filter((c) => c[0] === "sub-add");
  assert.equal(subs.length, 2);
  assert.deepEqual(subs[0].slice(2), ["auto", DANMAKU_TITLE, "zh"]);
  assert.match(subs[0][1], /^memory:\/\/\[Script Info\]/);
  assert.deepEqual(subs[1].slice(2), ["auto", "中文（中国）", "zh-CN"]);
  assert.match(subs[1][1], /^memory:\/\/1\n00:00:00,500 --> 00:00:02,250\n你好/);
  assert.equal(ctx.iina.props["file-local-options/secondary-sub-ass-override"], "no");
  assert.equal(ctx.player.current.hasDanmaku, true);
});

test("onLoad 在关闭弹幕与字幕时不请求它们", async () => {
  const ctx = setup({ danmaku_enable: false, subtitle_enable: false });
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  assert.equal(ctx.iina.commands.filter((c) => c[0] === "sub-add").length, 0);
  assert.ok(!ctx.env.requests.some((r) => /comment|player\/v2/.test(r.url)));
});

test("onLoad 在弹幕与字幕获取失败时仍正常播放视频", async () => {
  const routes = [[/comment\.bilibili\.com/, "<html>"], [/aisubtitle/, "oops"]].concat(VIDEO_ROUTES);
  const ctx = setup({}, routes);
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  assert.match(ctx.iina.props["stream-open-filename"], /^edl:/);
  assert.equal(ctx.iina.commands.filter((c) => c[0] === "sub-add").length, 0);
  assert.equal(ctx.player.current.hasDanmaku, false);
  assert.ok(ctx.env.logs.some(([lvl, m]) => lvl === "warn" && m.includes("弹幕获取失败")));
});

test("onLoad 把列表页替换为 m3u 播放列表", async () => {
  const ctx = setup({}, [[/web-interface\/view/, F.VIEW_MULTI]]);
  ctx.iina.props["stream-open-filename"] = "https://www.bilibili.com/video/BV1multi";
  await ctx.player.onLoad();
  assert.match(ctx.iina.props["stream-open-filename"], /^memory:\/\/#EXTM3U\n#EXTINF:60,P1 第一集\nhttps:\/\/www\.bilibili\.com\/video\/BV1multi\?p=1/);
  assert.equal(ctx.player.current, null);
});

test("onLoad 对空列表提示没有内容且不修改地址", async () => {
  const ctx = setup();
  const url = "https://search.bilibili.com/all";
  ctx.iina.props["stream-open-filename"] = url;
  await ctx.player.onLoad();
  assert.equal(ctx.iina.props["stream-open-filename"], url);
  assert.equal(ctx.iina.osds.at(-1), "没有可播放的内容");
});

test("onLoad 解析失败时保留原地址并显示原因", async () => {
  const ctx = setup({}, [[/web-interface\/view/, { code: -404, message: "啥都木有" }]]);
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  assert.equal(ctx.iina.props["stream-open-filename"], VIDEO_URL);
  assert.equal(ctx.iina.osds.at(-1), "B 站链接解析失败：啥都木有");
});

test("onLoad 捕获解析器抛出的异常", async () => {
  const iina = fakeIina({});
  const bili = createBili(mockEnv({}, []));
  const player = createPlayer(iina, bili, { route: async () => { throw new Error("炸了"); } });
  iina.props["stream-open-filename"] = VIDEO_URL;
  await player.onLoad();
  assert.match(iina.osds.at(-1), /B 站链接解析失败：解析出错: Error: 炸了/);
});

test("onLoad 播放试看片段时直接打开 mp4 并提示", async () => {
  const ctx = setup({}, [
    [/pgc\/view\/web\/season/, F.SEASON],
    [/pgc\/player\/web\/playurl/, F.PLAYURL_PREVIEW],
    [/comment/, F.DANMAKU_XML],
    [/player\/v2/, { code: 0, data: {} }],
  ]);
  ctx.iina.props["stream-open-filename"] = "https://www.bilibili.com/bangumi/play/ep5002";
  await ctx.player.onLoad();
  assert.equal(ctx.iina.props["stream-open-filename"], "https://upos-sz-x.bilivideo.com/preview.mp4");
  assert.equal(ctx.iina.props["file-local-options/vid"], undefined);
  assert.match(ctx.iina.osds.at(-1), /试看/);
});

test("onLoad 让 B 站视频使用精确跳转", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  assert.equal(ctx.iina.props["file-local-options/hr-seek"], "yes");
});

test("onLoad 打开直播流并使用直播 Referer", async () => {
  const ctx = setup({}, LIVE_ROUTES);
  ctx.iina.props["stream-open-filename"] = "https://live.bilibili.com/7734200";
  await ctx.player.onLoad();
  assert.equal(ctx.iina.props["stream-open-filename"], "https://cn-live.bilivideo.com/live/avc-150.flv?expires=1");
  assert.deepEqual(ctx.iina.props["file-local-options/http-header-fields"], ["Referer: " + LIVE_REFERER]);
  assert.equal(ctx.iina.props["file-local-options/force-media-title"], "【直播】直播标题");
});

// ---------------------------------------------------------------- 弹幕

test("onFileLoaded 按设置自动显示弹幕", async () => {
  const ctx = setup({ danmaku_show: true });
  await open(ctx, VIDEO_URL);
  assert.equal(ctx.iina.props.sid, "1");
  assert.equal(find(ctx.iina, "Bilibili", "显示弹幕").selected, true);
});

test("onFileLoaded 在设置为不显示时保持弹幕关闭", async () => {
  const ctx = setup({ danmaku_show: false });
  await open(ctx, VIDEO_URL);
  assert.equal(ctx.iina.props.sid, "no");
  assert.equal(find(ctx.iina, "Bilibili", "显示弹幕").selected, false);
});

test("toggleDanmaku 开关弹幕并记住选择", async () => {
  const ctx = setup({ danmaku_show: false });
  await open(ctx, VIDEO_URL);
  ctx.player.toggleDanmaku();
  assert.equal(ctx.iina.props.sid, "1");
  assert.equal(ctx.prefs.danmaku_show, true);
  assert.equal(ctx.iina.osds.at(-1), "弹幕：开");
  ctx.player.toggleDanmaku();
  assert.equal(ctx.iina.props.sid, "no");
  assert.equal(ctx.prefs.danmaku_show, false);
  assert.equal(ctx.iina.osds.at(-1), "弹幕：关");
});

test("toggleDanmaku 在显示 CC 字幕时把弹幕放到第二字幕", async () => {
  const ctx = setup({ danmaku_show: false });
  await open(ctx, VIDEO_URL);
  ctx.iina.props.sid = "2";
  ctx.player.toggleDanmaku();
  assert.equal(ctx.iina.props.sid, "2");
  assert.equal(ctx.iina.props["secondary-sid"], "1");
  ctx.player.toggleDanmaku();
  assert.equal(ctx.iina.props.sid, "2");
  assert.equal(ctx.iina.props["secondary-sid"], "no");
});

test("toggleDanmaku 在没有弹幕时提示", async () => {
  const ctx = setup({ danmaku_enable: false });
  await open(ctx, VIDEO_URL);
  ctx.player.toggleDanmaku();
  assert.equal(ctx.iina.osds.at(-1), "当前内容没有弹幕");
  assert.equal(find(ctx.iina, "Bilibili", "显示弹幕（没有弹幕）").enabled, false);
});

test("在原生字幕菜单里开关弹幕同样会被记住", async () => {
  const ctx = setup({ danmaku_show: true });
  await open(ctx, VIDEO_URL);
  ctx.iina.props.sid = "no";
  ctx.player.onTrackChanged("sub");
  assert.equal(ctx.prefs.danmaku_show, false);
  ctx.iina.props.sid = "2";
  ctx.player.onTrackChanged("sub");
  assert.equal(ctx.prefs.danmaku_show, false);
  ctx.iina.props["secondary-sid"] = "1";
  ctx.player.onTrackChanged("sub");
  assert.equal(ctx.prefs.danmaku_show, true);
});

// ---------------------------------------------------------------- 清晰度与音质

test("菜单列出清晰度并标记当前档位", async () => {
  const ctx = setup({ max_quality: "64" });
  await open(ctx, VIDEO_URL);
  const q = find(ctx.iina, "Bilibili", "清晰度");
  assert.deepEqual(q.items.map((i) => [i.title, i.selected]), [
    ["超清 4K · HEVC", false], ["高清 1080P · HEVC", false], ["高清 720P · AVC", true], ["清晰 480P · AVC", false],
  ]);
  assert.deepEqual(find(ctx.iina, "Bilibili", "音质").items.map((i) => i.title), ["Hi-Res 无损", "192K", "64K"]);
});

test("在菜单选择清晰度会切换视频轨道并记为默认上限", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  find(ctx.iina, "Bilibili", "清晰度", "高清 720P").action();
  assert.equal(ctx.iina.props.vid, "3");
  assert.equal(ctx.prefs.max_quality, "64");
  assert.equal(ctx.iina.osds.at(-1), "清晰度：高清 720P · AVC");
  // 选最高档记为不设上限
  find(ctx.iina, "Bilibili", "清晰度", "超清 4K").action();
  assert.equal(ctx.prefs.max_quality, "127");
});

test("在原生视频轨道菜单切换清晰度同样会被记住", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  ctx.iina.props.vid = "4";
  ctx.player.onTrackChanged("video");
  assert.equal(ctx.prefs.max_quality, "32");
  assert.equal(find(ctx.iina, "Bilibili", "清晰度", "清晰 480P").selected, true);
});

test("文件加载完成前的轨道变化不会改写偏好", async () => {
  const ctx = setup();
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  ctx.iina.props.vid = "4";
  ctx.player.onTrackChanged("video");
  assert.equal(ctx.prefs.max_quality, undefined);
  ctx.player.onFileLoaded();
  ctx.player.onEndFile();
  ctx.player.onTrackChanged("video");
  assert.equal(ctx.prefs.max_quality, undefined);
});

test("selectAudio 切换音轨", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  find(ctx.iina, "Bilibili", "音质", "64K").action();
  assert.equal(ctx.iina.props.aid, "3");
  assert.equal(ctx.iina.osds.at(-1), "音质：64K");
  ctx.player.selectAudio(9);
  assert.equal(ctx.iina.props.aid, "3");
});

test("切换编码偏好会保留进度、清晰度和音轨重新加载", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  ctx.iina.props.vid = "2";
  ctx.iina.props.aid = "2";
  ctx.iina.props["time-pos"] = 75.8;
  find(ctx.iina, "Bilibili", "视频编码偏好", "AVC").action();
  assert.equal(ctx.prefs.video_codec, "avc");
  assert.deepEqual(ctx.iina.commands.at(-1), ["playlist-play-index", "current"]);

  // mpv 重新加载同一个地址
  ctx.iina.commands.length = 0;
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  assert.equal(ctx.iina.props["file-local-options/start"], "75");
  assert.equal(ctx.iina.props["file-local-options/vid"], "2");
  assert.equal(ctx.iina.props["file-local-options/aid"], "2");
  assert.ok(ctx.player.current.video.every((v) => v.name.endsWith("AVC")));
});

test("选择当前已使用的编码不会重新加载", async () => {
  const ctx = setup({ video_codec: "hevc" });
  await open(ctx, VIDEO_URL);
  ctx.player.selectCodec("hevc");
  assert.ok(!ctx.iina.commands.some((c) => c[0] === "playlist-play-index"));
});

test("刷新播放地址从当前位置重新加载", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  ctx.iina.props["time-pos"] = 12.3;
  find(ctx.iina, "Bilibili", "刷新播放地址").action();
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  assert.equal(ctx.iina.props["file-local-options/start"], "12");
});

test("重新加载的状态只用于同一个链接", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  ctx.iina.props["time-pos"] = 99;
  find(ctx.iina, "Bilibili", "刷新播放地址").action();
  // mpv 每次加载文件都会重置 file-local-options，fake 不会，手动清除
  delete ctx.iina.props["file-local-options/start"];
  ctx.iina.props["stream-open-filename"] = "https://www.bilibili.com/video/BV1xx411c7mD";
  await ctx.player.onLoad();
  assert.equal(ctx.iina.props["file-local-options/start"], undefined);
});

// ---------------------------------------------------------------- 直播

test("直播菜单切换清晰度会记住并重新加载", async () => {
  const ctx = setup({ cookie_source: "manual", cookie: "SESSDATA=s; DedeUserID=42; buvid3=b" }, LIVE_ROUTES);
  await open(ctx, "https://live.bilibili.com/7734200");
  const q = find(ctx.iina, "Bilibili", "直播清晰度");
  assert.deepEqual(q.items.map((i) => [i.title, i.selected]), [["原画", false], ["蓝光", false], ["超清", false], ["高清", true]]);
  find(ctx.iina, "Bilibili", "直播清晰度", "蓝光").action();
  assert.equal(ctx.prefs.live_quality, "400");
  ctx.iina.props["stream-open-filename"] = "https://live.bilibili.com/7734200";
  await ctx.player.onLoad();
  assert.equal(ctx.player.current.qn, 400);
});

test("直播只有一档清晰度时提示登录", async () => {
  const one = JSON.parse(JSON.stringify(F.ROOM_PLAY));
  one.data.playurl_info.playurl.stream = one.data.playurl_info.playurl.stream.slice(0, 1);
  const ctx = setup({}, [[/getRoomPlayInfo/, one]].concat(LIVE_ROUTES));
  await open(ctx, "https://live.bilibili.com/7734200");
  const q = find(ctx.iina, "Bilibili", "直播清晰度");
  assert.equal(q.items.at(-1).title, "登录后可解锁更多清晰度");
  // 选择当前档位不重新加载
  q.items[0].action();
  assert.ok(!ctx.iina.commands.some((c) => c[0] === "playlist-play-index"));
});

// ---------------------------------------------------------------- 菜单与登录

test("没有播放 B 站内容时菜单只显示提示与登录项", () => {
  const ctx = setup();
  ctx.player.buildMenu();
  assert.deepEqual(find(ctx.iina, "Bilibili").items.map((i) => i.title), [
    "当前没有在播放 B 站内容", "-", "登录状态：检查中…", "重新读取登录信息",
  ]);
});

test("窗口加载完成前构建菜单不调用 forceUpdate", () => {
  const ctx = setup();
  let n = 0;
  ctx.iina.menu.forceUpdate = () => n++;
  ctx.player.buildMenu();
  assert.equal(n, 0);
  assert.ok(find(ctx.iina, "Bilibili"));
});

test("窗口或文件加载完成后构建菜单会调用 forceUpdate", () => {
  for (const ready of ["onWindowLoaded", "onFileLoaded"]) {
    const ctx = setup();
    let n = 0;
    ctx.iina.menu.forceUpdate = () => n++;
    ctx.player[ready]();
    ctx.player.buildMenu();
    assert.equal(n, 2, ready);
  }
});

test("在浏览器中打开当前视频页面", async () => {
  const ctx = setup();
  let opened = null;
  ctx.iina.utils.open = (u) => { opened = u; };
  await open(ctx, VIDEO_URL);
  find(ctx.iina, "Bilibili", "在浏览器中打开").action();
  assert.equal(opened, "https://www.bilibili.com/video/BV1xx411c7mD");
});

test("登录状态显示 UID 与来源", async () => {
  const cases = [
    [{ cookie_source: "manual", cookie: "SESSDATA=s; DedeUserID=42" }, "已登录（手动填写，UID 42）"],
    [{ cookie_source: "manual", cookie: "" }, "未登录（手动填写）"],
    [{ cookie_source: "none" }, "未登录（设置中已关闭登录）"],
  ];
  for (const [prefs, label] of cases) {
    const ctx = setup(prefs);
    await ctx.player.updateLoginLabel(false);
    ctx.player.buildMenu();
    assert.ok(find(ctx.iina, "Bilibili", "登录状态：" + label), label);
  }
});

test("重新读取登录信息会刷新状态并显示提示", async () => {
  const ctx = setup({ cookie_source: "manual", cookie: "DedeUserID=7" });
  ctx.player.buildMenu();
  await find(ctx.iina, "Bilibili", "重新读取登录信息").action();
  assert.equal(ctx.iina.osds.at(-1), "已登录（手动填写，UID 7）");
  assert.ok(find(ctx.iina, "Bilibili", "登录状态：已登录"));
});

test("切换到非 B 站文件后清除当前状态", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  ctx.iina.props["stream-open-filename"] = "/tmp/a.mp4";
  await ctx.player.onLoad();
  ctx.player.onFileLoaded();
  assert.equal(ctx.player.current, null);
  assert.ok(find(ctx.iina, "Bilibili", "当前没有在播放 B 站内容"));
});

test("OSD 抛出异常时不影响加载", async () => {
  const ctx = setup();
  ctx.iina.core.osd = () => { throw new Error("window not loaded"); };
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  assert.match(ctx.iina.props["stream-open-filename"], /^edl:/);
});

// ---------------------------------------------------------------- 侧边栏

// 记录 player 推给侧边栏的每一份状态
function watch(ctx) {
  const states = [];
  ctx.iina.onState = (s) => states.push(JSON.parse(JSON.stringify(s)));
  return states;
}

test("侧边栏状态在没有播放时只含登录与编码", () => {
  const ctx = setup({ video_codec: "av1" });
  assert.deepEqual(ctx.player.snapshot(), {
    login: "检查中…", codec: "av1", loading: false, error: "", item: null,
    danmakuStyle: { font: "", fontSize: 48, opacity: 0.8, displayArea: 0.8, scrollTime: 10, bold: true },
  });
});

test("侧边栏状态列出视频的清晰度、音质、当前选择与弹幕", async () => {
  const ctx = setup({ max_quality: "64", danmaku_show: true });
  await open(ctx, VIDEO_URL);
  const item = ctx.player.snapshot().item;
  assert.equal(item.type, "video");
  assert.ok(item.title);
  assert.deepEqual(item.video.map((v) => v.name), ["超清 4K · HEVC", "高清 1080P · HEVC", "高清 720P · AVC", "清晰 480P · AVC"]);
  assert.equal(item.videoIndex, 2);
  assert.deepEqual(item.audio.map((a) => a.name), ["Hi-Res 无损", "192K", "64K"]);
  assert.equal(item.hasDanmaku, true);
  assert.equal(item.danmaku, true);
});

test("侧边栏状态列出直播清晰度与当前档位", async () => {
  const ctx = setup({ cookie_source: "manual", cookie: "SESSDATA=s; DedeUserID=42; buvid3=b" }, LIVE_ROUTES);
  await open(ctx, "https://live.bilibili.com/7734200");
  const item = ctx.player.snapshot().item;
  assert.equal(item.type, "live");
  assert.deepEqual(item.qualities.map((q) => q.name), ["原画", "蓝光", "超清", "高清"]);
  assert.equal(item.qn, 150);
  assert.equal(item.video, undefined);
});

test("侧边栏状态带上正在播放的链接，供浏览列表标出当前条目", async () => {
  const ctx = setup({}, LIVE_ROUTES);
  await open(ctx, "https://live.bilibili.com/7734200");
  assert.equal(ctx.player.snapshot().item.url, "https://live.bilibili.com/7734200");
});

test("解析过程中侧边栏先显示解析中，失败后显示原因", async () => {
  const ctx = setup({}, [[/web-interface\/view/, { code: -404, message: "啥都木有" }]]);
  const states = watch(ctx);
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  assert.equal(states[0].loading, true);
  assert.deepEqual([states.at(-1).loading, states.at(-1).error], [false, "啥都木有"]);
});

test("打开非 B 站文件会清除侧边栏的失败原因", async () => {
  const ctx = setup({}, [[/web-interface\/view/, { code: -404, message: "啥都木有" }]]);
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  ctx.iina.props["stream-open-filename"] = "/tmp/a.mp4";
  await ctx.player.onLoad();
  assert.equal(ctx.player.snapshot().error, "");
});

test("轨道变化后侧边栏收到新的选择", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  const states = watch(ctx);
  ctx.iina.props.vid = "4";
  ctx.player.onTrackChanged("video");
  assert.equal(states.at(-1).item.videoIndex, 3);
});

test("侧边栏回调抛出异常时不影响菜单", async () => {
  const ctx = setup();
  ctx.iina.onState = () => { throw new Error("网页没了"); };
  await open(ctx, VIDEO_URL);
  assert.ok(find(ctx.iina, "Bilibili", "清晰度"));
  assert.ok(ctx.env.logs.some((l) => l[0] === "warn" && l[1].includes("网页没了")));
});

test("侧边栏选择清晰度会切换轨道并记住", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  ctx.player.handleAction({ type: "video", index: 2 });
  assert.equal(ctx.iina.props.vid, "3");
  assert.equal(ctx.prefs.max_quality, "64");
});

test("侧边栏传来越界或非数字的下标时不做任何改动", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  const vid = ctx.iina.props.vid;
  for (const index of [9, -1, "x", undefined]) ctx.player.handleAction({ type: "video", index });
  ctx.player.handleAction({ type: "audio", index: 9 });
  assert.equal(ctx.iina.props.vid, vid);
  assert.equal(ctx.prefs.max_quality, undefined);
});

test("侧边栏切换音质", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  ctx.player.handleAction({ type: "audio", index: 2 });
  assert.equal(ctx.iina.props.aid, "3");
});

test("侧边栏切换编码会重新加载，未知编码被忽略", async () => {
  const ctx = setup({ video_codec: "hevc" });
  await open(ctx, VIDEO_URL);
  ctx.player.handleAction({ type: "codec", name: "vp9" });
  assert.equal(ctx.prefs.video_codec, "hevc");
  ctx.player.handleAction({ type: "codec", name: "av1" });
  assert.equal(ctx.prefs.video_codec, "av1");
  assert.deepEqual(ctx.iina.commands.at(-1), ["playlist-play-index", "current"]);
});

test("没有播放时切换编码只保存偏好并刷新侧边栏", () => {
  const ctx = setup({ video_codec: "hevc" });
  const states = watch(ctx);
  ctx.player.handleAction({ type: "codec", name: "avc" });
  assert.equal(states.at(-1).codec, "avc");
  assert.ok(!ctx.iina.commands.some((c) => c[0] === "playlist-play-index"));
});

test("侧边栏开关弹幕", async () => {
  const ctx = setup({ danmaku_show: false });
  await open(ctx, VIDEO_URL);
  const states = watch(ctx);
  ctx.player.handleAction({ type: "danmaku" });
  assert.equal(ctx.prefs.danmaku_show, true);
  ctx.player.onTrackChanged("sub");
  assert.equal(states.at(-1).item.danmaku, true);
});

// 让模拟的 mpv 像真实 mpv 一样在 sub-add/sub-remove 时更新轨道列表，新轨道 id 递增
function liveTracks(iina) {
  const command = iina.mpv.command;
  iina.mpv.command = (name, args) => {
    command(name, args);
    const list = iina.props["track-list"];
    if (name === "sub-add") {
      const id = Math.max(0, ...list.filter((t) => t.type === "sub").map((t) => t.id)) + 1;
      list.push({ id, type: "sub", external: true, title: args[2] });
    }
    if (name === "sub-remove") iina.props["track-list"] = list.filter((t) => !(t.type === "sub" && t.id === Number(args[0])));
  };
}

const danmakuAdds = (iina) => iina.commands.filter((c) => c[0] === "sub-add" && c[3] === DANMAKU_TITLE);

test("侧边栏修改弹幕样式会记住设置，并用新样式替换正在显示的弹幕轨", async () => {
  const ctx = setup({ danmaku_show: true });
  await open(ctx, VIDEO_URL);
  liveTracks(ctx.iina);
  const states = watch(ctx);
  assert.equal(ctx.iina.props.sid, "1");
  await ctx.player.handleAction({ type: "danmakuStyle", key: "fontSize", value: 60 });
  assert.equal(ctx.prefs.danmaku_font_size, 60);
  assert.match(danmakuAdds(ctx.iina).at(-1)[1], /Style: Danmaku,PingFang SC,60,/);
  // 新轨道 id 为 3（1 是旧弹幕，2 是 CC 字幕），接替主字幕后删除旧轨道
  assert.equal(ctx.iina.props.sid, "3");
  assert.deepEqual(ctx.iina.commands.at(-1), ["sub-remove", "1"]);
  assert.deepEqual(ctx.iina.props["track-list"].filter((t) => t.title === DANMAKU_TITLE).map((t) => t.id), [3]);
  assert.equal(states.at(-1).danmakuStyle.fontSize, 60);
  assert.equal(states.at(-1).item.danmaku, true);
  // 弹幕 XML 不常驻内存，修改样式时重新下载
  assert.ok(!JSON.stringify(ctx.player.current).includes("<d p="));
  assert.equal(ctx.env.requests.filter((r) => /comment\.bilibili\.com/.test(r.url)).length, 2);
});

test("修改样式时重新下载弹幕失败，保留原来的弹幕轨并提示", async () => {
  let fail = false;
  const routes = [[/comment\.bilibili\.com/, () => (fail ? null : F.DANMAKU_XML)]].concat(VIDEO_ROUTES);
  const ctx = setup({ danmaku_show: true }, routes);
  await open(ctx, VIDEO_URL);
  liveTracks(ctx.iina);
  fail = true;
  await ctx.player.handleAction({ type: "danmakuStyle", key: "fontSize", value: 60 });
  assert.equal(ctx.prefs.danmaku_font_size, 60);
  assert.equal(danmakuAdds(ctx.iina).length, 1);
  assert.equal(ctx.iina.props.sid, "1");
  assert.match(ctx.iina.osds.at(-1), /重新获取弹幕失败/);
});

test("连续修改样式时只按最后一次替换弹幕轨，下载期间换了视频则不替换", async () => {
  const ctx = setup({ danmaku_show: true });
  await open(ctx, VIDEO_URL);
  liveTracks(ctx.iina);
  await Promise.all([
    ctx.player.handleAction({ type: "danmakuStyle", key: "fontSize", value: 60 }),
    ctx.player.handleAction({ type: "danmakuStyle", key: "fontSize", value: 70 }),
  ]);
  assert.equal(danmakuAdds(ctx.iina).length, 2);
  assert.match(danmakuAdds(ctx.iina).at(-1)[1], /Style: Danmaku,PingFang SC,70,/);
  assert.equal(ctx.iina.props.sid, "3");

  const pending = ctx.player.handleAction({ type: "danmakuStyle", key: "fontSize", value: 80 });
  ctx.iina.props["stream-open-filename"] = "/tmp/other.mp4";
  await ctx.player.onLoad();
  await pending;
  assert.equal(danmakuAdds(ctx.iina).length, 2);
});

test("弹幕作为第二字幕显示时替换后仍是第二字幕，关闭时替换后仍关闭", async () => {
  const ctx = setup({ danmaku_show: false });
  await open(ctx, VIDEO_URL);
  liveTracks(ctx.iina);
  await ctx.player.handleAction({ type: "danmakuStyle", key: "opacity", value: 0.5 });
  assert.equal(ctx.iina.props.sid, "no");
  assert.equal(ctx.iina.props["secondary-sid"], "no");
  assert.match(danmakuAdds(ctx.iina).at(-1)[1], /&H80FFFFFF/);
  ctx.iina.props.sid = "2";
  ctx.player.toggleDanmaku();
  assert.equal(ctx.iina.props["secondary-sid"], "3");
  await ctx.player.handleAction({ type: "danmakuStyle", key: "bold", value: false });
  assert.equal(ctx.iina.props.sid, "2");
  assert.equal(ctx.iina.props["secondary-sid"], "4");
  assert.equal(ctx.prefs.danmaku_bold, false);
});

test("侧边栏的弹幕样式值会被校验、限制范围，值未变时不重新生成", async () => {
  const ctx = setup();
  await open(ctx, VIDEO_URL);
  liveTracks(ctx.iina);
  const before = danmakuAdds(ctx.iina).length;
  for (const [key, value] of [["fontSize", "60"], ["bold", 1], ["font", 3], ["nope", 1], ["displayArea", NaN]]) {
    await ctx.player.handleAction({ type: "danmakuStyle", key, value });
  }
  await ctx.player.handleAction({ type: "danmakuStyle", key: "fontSize", value: 48 });
  assert.equal(danmakuAdds(ctx.iina).length, before);
  assert.equal(ctx.env.logs.filter((l) => l[0] === "warn" && l[1].includes("无效的弹幕样式")).length, 5);
  await ctx.player.handleAction({ type: "danmakuStyle", key: "fontSize", value: 999.4 });
  await ctx.player.handleAction({ type: "danmakuStyle", key: "displayArea", value: 0 });
  await ctx.player.handleAction({ type: "danmakuStyle", key: "font", value: " Songti SC,Bold " });
  assert.equal(ctx.prefs.danmaku_font_size, 200);
  assert.equal(ctx.prefs.danmaku_display_area, 0.1);
  assert.equal(ctx.prefs.danmaku_font, "Songti SCBold");
  assert.match(danmakuAdds(ctx.iina).at(-1)[1], /Style: Danmaku,Songti SCBold,200,/);
});

test("恢复默认弹幕样式", async () => {
  const ctx = setup({ danmaku_font: "Kaiti SC", danmaku_font_size: 70, danmaku_bold: false, danmaku_fixed_time: 8 });
  await open(ctx, VIDEO_URL);
  liveTracks(ctx.iina);
  await ctx.player.handleAction({ type: "danmakuStyle", reset: true });
  assert.deepEqual(ctx.player.snapshot().danmakuStyle,
    { font: "", fontSize: 48, opacity: 0.8, displayArea: 0.8, scrollTime: 10, bold: true });
  // 侧边栏里没有的设置不受影响
  assert.equal(ctx.prefs.danmaku_fixed_time, 8);
  assert.match(danmakuAdds(ctx.iina).at(-1)[1], /Style: Danmaku,PingFang SC,48,/);
});

test("没有弹幕或没有播放时修改弹幕样式只保存设置", async () => {
  const ctx = setup({ danmaku_enable: false });
  await ctx.player.handleAction({ type: "danmakuStyle", key: "scrollTime", value: 6 });
  assert.equal(ctx.prefs.danmaku_scroll_time, 6);
  await open(ctx, VIDEO_URL);
  liveTracks(ctx.iina);
  const states = watch(ctx);
  await ctx.player.handleAction({ type: "danmakuStyle", key: "scrollTime", value: 8 });
  assert.equal(ctx.prefs.danmaku_scroll_time, 8);
  assert.equal(states.at(-1).danmakuStyle.scrollTime, 8);
  assert.equal(danmakuAdds(ctx.iina).length, 0);
});

test("侧边栏切换直播清晰度", async () => {
  const ctx = setup({ cookie_source: "manual", cookie: "SESSDATA=s; DedeUserID=42; buvid3=b" }, LIVE_ROUTES);
  await open(ctx, "https://live.bilibili.com/7734200");
  ctx.player.handleAction({ type: "live", qn: "400" });
  assert.equal(ctx.prefs.live_quality, "400");
});

test("侧边栏的刷新、浏览器打开与重新读取登录", async () => {
  const ctx = setup({ cookie_source: "manual", cookie: "DedeUserID=7" });
  let opened = null;
  ctx.iina.utils.open = (u) => { opened = u; };
  await open(ctx, VIDEO_URL);
  ctx.iina.props["time-pos"] = 12.3;
  ctx.player.handleAction({ type: "reload" });
  assert.deepEqual(ctx.iina.commands.at(-1), ["playlist-play-index", "current"]);
  ctx.player.handleAction({ type: "open" });
  assert.equal(opened, "https://www.bilibili.com/video/BV1xx411c7mD");
  await ctx.player.handleAction({ type: "login" });
  assert.match(ctx.player.snapshot().login, /UID 7/);
});

test("没有播放时侧边栏的浏览器打开不做任何事", () => {
  const ctx = setup();
  let opened = 0;
  ctx.iina.utils.open = () => { opened++; };
  ctx.player.handleAction({ type: "open" });
  assert.equal(opened, 0);
});

test("侧边栏的未知操作只记录警告", () => {
  const ctx = setup();
  ctx.player.handleAction({ type: "rm -rf" });
  ctx.player.handleAction(null);
  assert.equal(ctx.env.logs.filter((l) => l[0] === "warn" && l[1].includes("未知的侧边栏操作")).length, 2);
});

test("提供 showSidebar 时菜单里有显示侧边栏", () => {
  const ctx = setup();
  let shown = 0;
  ctx.iina.showSidebar = () => { shown++; };
  ctx.player.buildMenu();
  find(ctx.iina, "Bilibili", "显示侧边栏").action();
  assert.equal(shown, 1);
});

// ---------------------------------------------------------------- 连播

const MULTI_ROUTES = [[/web-interface\/view/, F.VIEW_MULTI]].concat(VIDEO_ROUTES);

test("单独打开多 P 中的某一 P 时把后面的分 P 追加到播放列表", async () => {
  const ctx = setup({}, MULTI_ROUTES);
  Object.assign(ctx.iina.props, { "playlist-pos": 0, "playlist-count": 1 });
  await open(ctx, "https://www.bilibili.com/video/BV1multi?p=1");
  const add = ctx.iina.commands.filter((c) => c[0] === "loadlist");
  assert.deepEqual(add, [["loadlist", "memory://#EXTM3U\n#EXTINF:70,P2 第二集\nhttps://www.bilibili.com/video/BV1multi?p=2", "append"]]);
});

test("从列表展开的条目、不是最后一项、已是最后一 P 或关闭连播时不追加", async () => {
  const cases = [
    [{}, { "playlist-pos": 0, "playlist-count": 1, "playlist/0/playlist-path": "https://space.bilibili.com/1" }, "?p=1"],
    [{}, { "playlist-pos": 0, "playlist-count": 2 }, "?p=1"],
    [{}, { "playlist-pos": 0, "playlist-count": 1 }, "?p=2"],
    [{ autoplay_next: false }, { "playlist-pos": 0, "playlist-count": 1 }, "?p=1"],
  ];
  for (const [prefs, props, query] of cases) {
    const ctx = setup(prefs, MULTI_ROUTES);
    Object.assign(ctx.iina.props, props);
    await open(ctx, "https://www.bilibili.com/video/BV1multi" + query);
    assert.ok(!ctx.iina.commands.some((c) => c[0] === "loadlist"), JSON.stringify([prefs, props, query]));
  }
});

// ---------------------------------------------------------------- 流畅弹幕

const smoothFps = (iina) => {
  const f = (iina.props.vf || []).find((x) => x.label === "bilidm");
  return f ? Number(f.params.fps) : 0;
};

test("显示弹幕时把 30 帧的视频补到屏幕刷新率，未知时按 60", async () => {
  let ctx = setup({ danmaku_show: true });
  ctx.iina.props["display-fps"] = 74.97;
  await open(ctx, VIDEO_URL);
  assert.equal(smoothFps(ctx.iina), 75);
  // 在 on_load 里加好，文件打开后不用再重建滤镜链
  assert.equal(ctx.iina.commands.filter((c) => c[0] === "vf").length, 1);

  ctx = setup({ danmaku_show: true });
  await open(ctx, VIDEO_URL);
  assert.equal(smoothFps(ctx.iina), 60);
});

test("关掉弹幕、关闭设置、高帧率视频或直播时不补帧", async () => {
  for (const prefs of [{ danmaku_show: false }, { danmaku_smooth: false }, { danmaku_enable: false }]) {
    const ctx = setup(Object.assign({ danmaku_show: true }, prefs));
    await open(ctx, VIDEO_URL);
    assert.equal(smoothFps(ctx.iina), 0, JSON.stringify(prefs));
  }

  // 屏幕刷新率不比视频高
  let ctx = setup({ danmaku_show: true });
  ctx.iina.props["display-fps"] = 30;
  await open(ctx, VIDEO_URL);
  assert.equal(smoothFps(ctx.iina), 0);

  // 上一个视频留下的滤镜在打开直播和其他文件时去掉
  for (const [url, routes] of [["https://live.bilibili.com/7734200", LIVE_ROUTES], ["/Users/me/movie.mkv", VIDEO_ROUTES]]) {
    ctx = setup({ danmaku_show: true }, routes);
    ctx.iina.props.vf = [{ label: "bilidm", name: "fps", params: { fps: "60" } }];
    ctx.iina.props["stream-open-filename"] = url;
    await ctx.player.onLoad();
    assert.equal(smoothFps(ctx.iina), 0, url);
  }
});

test("开关弹幕、换屏幕时随之启用或停用补帧", async () => {
  const ctx = setup({ danmaku_show: true });
  await open(ctx, VIDEO_URL);
  ctx.player.toggleDanmaku();
  ctx.player.onTrackChanged("sub");
  assert.equal(smoothFps(ctx.iina), 0);
  ctx.player.toggleDanmaku();
  ctx.player.onTrackChanged("sub");
  assert.equal(smoothFps(ctx.iina), 60);
  ctx.iina.props["display-fps"] = 120;
  ctx.player.onDisplayFps();
  assert.equal(smoothFps(ctx.iina), 120);
  // 目标不变时不重复设置
  const n = ctx.iina.commands.length;
  ctx.player.onDisplayFps();
  assert.equal(ctx.iina.commands.length, n);
});

test("关闭弹幕时，IINA 恢复的上次字幕选择不会把弹幕打开", async () => {
  const ctx = setup({ danmaku_show: false });
  ctx.iina.props["stream-open-filename"] = VIDEO_URL;
  await ctx.player.onLoad();
  loadTracks(ctx.iina);
  const dm = ctx.iina.props["track-list"].find((t) => t.title === DANMAKU_TITLE);
  ctx.iina.props.sid = String(dm.id);
  ctx.player.onFileLoaded();
  assert.equal(ctx.iina.props.sid, "no");
  assert.equal(ctx.prefs.danmaku_show, false);
});

// ---------------------------------------------------------------- 播放进度

const LOGIN = { cookie_source: "manual", cookie: "SESSDATA=s; DedeUserID=42; bili_jct=tok; buvid3=b" };
const PLAIN_URL = "https://www.bilibili.com/video/BV1xx411c7mD";
const lastPlay = (ms, cid) => ({ code: 0, data: { ...F.PLAYER_V2.data, last_play_time: ms, last_play_cid: cid || 1001 } });

// 已登录的播放器；reported 记录每次上报的表单
// 关掉预加载，计时器只剩进度上报这一个
// extra 是排在默认路由前面的路由
function syncSetup(prefs, v2, reply, extra) {
  const reported = [];
  const ctx = setup(Object.assign({ preload_next: false }, LOGIN, prefs), (extra || []).concat([
    [/player\/v2/, v2 || F.PLAYER_V2],
    [/history\/report/, (url, req) => {
      const file = req.args[req.args.indexOf("--data-binary") + 1].slice(1);
      reported.push(Object.fromEntries(new URLSearchParams(fs.readFileSync(file, "utf8"))));
      return reply || { code: 0 };
    }],
  ], VIDEO_ROUTES));
  ctx.reported = reported;
  return ctx;
}

test("已登录时从 B 站记录的进度继续播放并提示", async () => {
  const ctx = syncSetup({}, lastPlay(61000));
  await open(ctx, PLAIN_URL);
  assert.equal(ctx.iina.props["file-local-options/start"], "61");
  assert.equal(ctx.iina.osds.at(-1), "从上次看到的 1:01 继续播放");
});

test("链接里的 t=、重新加载时的进度优先于播放记录；不同分 P 或快看完时不续播", async () => {
  let ctx = syncSetup({}, lastPlay(61000));
  await open(ctx, VIDEO_URL);
  assert.equal(ctx.iina.props["file-local-options/start"], "30");
  assert.ok(!ctx.iina.osds.some((m) => m.startsWith("从上次")));

  // 刷新播放地址时沿用当前进度，即使是 0 也不跳到播放记录
  ctx = syncSetup({}, lastPlay(61000));
  await open(ctx, PLAIN_URL);
  ctx.iina.props["time-pos"] = 0;
  ctx.player.handleAction({ type: "reload" });
  delete ctx.iina.props["file-local-options/start"];
  ctx.iina.props["stream-open-filename"] = PLAIN_URL;
  await ctx.player.onLoad();
  assert.equal(ctx.iina.props["file-local-options/start"], undefined);

  // 拿到了记录但不用续播时显式从头播放，IINA 自己记下的位置不生效
  for (const v2 of [lastPlay(61000, 999), lastPlay(100000), lastPlay(0)]) {
    ctx = syncSetup({}, v2);
    await open(ctx, PLAIN_URL);
    assert.equal(ctx.iina.props["file-local-options/start"], "none", JSON.stringify(v2.data));
  }

  // 没拿到记录时交给 IINA
  ctx = syncSetup({}, { code: -400, message: "boom" });
  await open(ctx, PLAIN_URL);
  assert.equal(ctx.iina.props["file-local-options/start"], undefined);
});

test("playurl 带回的播放记录优先，player/v2 没有进度时也能续播", async () => {
  const playurl = (ms, cid) => ({ code: 0, data: { ...F.PLAYURL.data, last_play_time: ms, last_play_cid: cid } });
  let ctx = syncSetup({}, lastPlay(0), null, [[/player\/playurl/, playurl(45000, 1001)]]);
  await open(ctx, PLAIN_URL);
  assert.equal(ctx.iina.props["file-local-options/start"], "45");
  assert.ok(ctx.env.requests.some((r) => /player\/v2\?aid=\d+&bvid=/.test(r.url)));

  // playurl 没有进度时用 player/v2 的
  ctx = syncSetup({}, lastPlay(61000), null, [[/player\/playurl/, playurl(-1000, 1001)]]);
  await open(ctx, PLAIN_URL);
  assert.equal(ctx.iina.props["file-local-options/start"], "61");
});

test("番剧从剧集信息里的 user_status 续播，只认同一集", async () => {
  const season = (epId, sec) => ({ code: 0, result: { ...F.SEASON.result, user_status: { progress: { last_ep_id: epId, last_ep_index: "1", last_time: sec } } } });
  const routes = (s) => [
    [/pgc\/view\/web\/season/, s],
    [/pgc\/player\/web\/playurl/, { code: 0, result: F.PLAYURL.data }],
  ];
  let ctx = syncSetup({}, lastPlay(0, 7001), null, routes(season(5001, 300)));
  await open(ctx, "https://www.bilibili.com/bangumi/play/ep5001");
  assert.equal(ctx.iina.props["file-local-options/start"], "300");

  ctx = syncSetup({}, lastPlay(0, 7001), null, routes(season(5002, 300)));
  await open(ctx, "https://www.bilibili.com/bangumi/play/ep5001");
  assert.equal(ctx.iina.props["file-local-options/start"], "none");
});

test("未登录或关闭同步时不续播也不上报", async () => {
  for (const prefs of [{ cookie_source: "none" }, { sync_progress: false }]) {
    const ctx = syncSetup(prefs, lastPlay(61000));
    await open(ctx, PLAIN_URL);
    assert.equal(ctx.iina.props["file-local-options/start"], undefined);
    assert.equal(ctx.iina.timers.active(), 0);
    ctx.iina.props["time-pos"] = 50;
    await ctx.player.onEndFile();
    assert.deepEqual(ctx.reported, []);
  }
});

test("关闭字幕时仍然读取播放记录", async () => {
  const ctx = syncSetup({ subtitle_enable: false }, lastPlay(61000));
  await open(ctx, PLAIN_URL);
  assert.equal(ctx.iina.props["file-local-options/start"], "61");
  assert.equal(ctx.iina.commands.filter((c) => c[0] === "sub-add").length, 1);
});

test("播放中每走 15 秒上报一次进度，暂停时立即上报", async () => {
  const ctx = syncSetup();
  await open(ctx, PLAIN_URL);
  const { props, timers } = ctx.iina;
  assert.equal(timers.active(), 1);
  props["time-pos"] = 10.9;
  await timers.tick();
  assert.deepEqual(ctx.reported, []);
  props["time-pos"] = 20.2;
  await timers.tick();
  props["time-pos"] = 25;
  await timers.tick();
  assert.deepEqual(ctx.reported, [{ aid: "2", cid: "1001", progress: "20", csrf: "tok" }]);
  // 往回拖动同样会上报
  props["time-pos"] = 3;
  await timers.tick();
  assert.equal(ctx.reported.at(-1).progress, "3");

  props["time-pos"] = 8;
  props.pause = true;
  await ctx.player.onPause();
  props.pause = false;
  await ctx.player.onPause();
  assert.deepEqual(ctx.reported.map((r) => r.progress), ["20", "3", "8"]);
});

test("换视频时用最后记下的位置上报并停止计时", async () => {
  const ctx = syncSetup();
  await open(ctx, PLAIN_URL);
  ctx.iina.props["time-pos"] = 40;
  await ctx.iina.timers.tick();
  // 文件已经卸载，拿不到 time-pos
  delete ctx.iina.props["time-pos"];
  await ctx.player.onEndFile();
  assert.deepEqual(ctx.reported.map((r) => r.progress), ["40"]);
  assert.equal(ctx.iina.timers.active(), 0);
  // 已经报过的位置不重复上报
  await ctx.player.onEndFile();
  assert.equal(ctx.reported.length, 1);
});

test("关闭窗口时上报当前进度", async () => {
  const ctx = syncSetup();
  await open(ctx, PLAIN_URL);
  ctx.iina.props["time-pos"] = 33.3;
  await ctx.player.onWindowClose();
  assert.deepEqual(ctx.reported.map((r) => r.progress), ["33"]);
  assert.equal(ctx.iina.timers.active(), 0);
});

test("没有 bili_jct 时不上报；上报失败只记录警告", async () => {
  let ctx = syncSetup({ cookie: "SESSDATA=s; DedeUserID=42; buvid3=b" });
  await open(ctx, PLAIN_URL);
  ctx.iina.props["time-pos"] = 50;
  await ctx.player.onWindowClose();
  assert.deepEqual(ctx.reported, []);

  ctx = syncSetup({}, null, { code: -101, message: "账号未登录" });
  await open(ctx, PLAIN_URL);
  ctx.iina.props["time-pos"] = 50;
  await ctx.player.onWindowClose();
  assert.equal(ctx.reported.length, 1);
  assert.ok(ctx.env.logs.some(([lvl, m]) => lvl === "warn" && m.includes("播放进度上报失败")));
  // 不影响侧边栏显示的解析错误
  assert.equal(ctx.bili.state.lastError, "");
});

test("直播不上报进度", async () => {
  const ctx = setup(LOGIN, LIVE_ROUTES);
  await open(ctx, "https://live.bilibili.com/7734200");
  assert.equal(ctx.iina.timers.active(), 0);
});

// ---------------------------------------------------------------- 预加载

const NEXT_URL = "https://www.bilibili.com/video/BV1xx411c7mD?p=1";
const warms = (ctx) => ctx.env.requests.filter((r) => r.args.includes("-r"));
const count = (ctx, re) => ctx.env.requests.filter((r) => re.test(r.url) && !r.args.includes("-r")).length;

// 播放列表里还有下一项，当前视频时长 120 秒；每次 tick 相当于过了 5 秒
async function preloadSetup(prefs, next, routes) {
  const ctx = setup(prefs, routes);
  Object.assign(ctx.iina.props, { "playlist-pos": 0, "playlist-count": 2, "playlist/1/filename": next || NEXT_URL, duration: 120 });
  await open(ctx, PLAIN_URL);
  return ctx;
}

async function playTo(ctx, t) {
  ctx.iina.props["time-pos"] = t;
  await ctx.iina.timers.tick();
}

async function openNext(ctx, url) {
  await ctx.player.onEndFile();
  ctx.iina.props["playlist-pos"] = 1;
  ctx.iina.props["stream-open-filename"] = url || NEXT_URL;
  await ctx.player.onLoad();
}

test("剩余不到 60 秒时预加载下一项，并预热将要播放的那一档音视频", async () => {
  const ctx = await preloadSetup();
  assert.equal(count(ctx, /web-interface\/view/), 1);
  // 起播后的头一次检查不做事；剩余 90 秒时也不做
  await playTo(ctx, 25);
  await playTo(ctx, 30);
  assert.equal(count(ctx, /web-interface\/view/), 1);
  await playTo(ctx, 61);
  assert.equal(count(ctx, /web-interface\/view/), 2);
  assert.equal(count(ctx, /player\/playurl/), 2);

  // 只预热默认选中的清晰度和音轨，各读开头 1MB，不带 Cookie
  const urls = warms(ctx).map((r) => r.url);
  const info = ctx.player.current;
  assert.deepEqual(urls, [info.video[info.videoIndex].url, info.audio[info.audioIndex].url]);
  for (const r of warms(ctx)) {
    assert.equal(r.args[r.args.indexOf("-r") + 1], "0-1048575");
    assert.equal(r.args[r.args.indexOf("-o") + 1], "/dev/null");
    assert.equal(r.cookie, null);
  }

  // 同一个下一项只预加载一次
  await playTo(ctx, 10);
  await playTo(ctx, 100);
  assert.equal(count(ctx, /web-interface\/view/), 2);
});

test("轮到下一项时直接使用预加载的结果，只重新获取弹幕", async () => {
  const ctx = await preloadSetup();
  await playTo(ctx, 0);
  await playTo(ctx, 70);
  const before = { view: count(ctx, /web-interface\/view/), play: count(ctx, /player\/playurl/), v2: count(ctx, /player\/v2/), dm: count(ctx, /comment\.bilibili/) };
  await openNext(ctx);
  assert.equal(count(ctx, /web-interface\/view/), before.view);
  assert.equal(count(ctx, /player\/playurl/), before.play);
  assert.equal(count(ctx, /player\/v2/), before.v2);
  assert.equal(count(ctx, /comment\.bilibili/), before.dm + 1);
  assert.ok(ctx.iina.props["stream-open-filename"].startsWith("edl://"));
  assert.equal(ctx.iina.commands.filter((c) => c[0] === "sub-add").length, 4);
  assert.equal(ctx.player.current.pageUrl, NEXT_URL);
  // 结果用过就丢，再打开同一链接会重新解析
  await openNext(ctx);
  assert.equal(count(ctx, /web-interface\/view/), before.view + 1);
});

test("预加载还没完成时等它完成，不重复请求", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = await preloadSetup();
  // mockEnv 的路由不支持异步返回值，包装 exec 让预加载的取流请求卡住
  const exec = ctx.env.exec;
  let delayed = false;
  ctx.env.exec = async (file, args) => {
    if (!delayed && /player\/playurl/.test(args[args.length - 1])) {
      delayed = true;
      await gate;
    }
    return exec(file, args);
  };
  ctx.iina.props["time-pos"] = 0;
  ctx.iina.timers.tick();
  ctx.iina.props["time-pos"] = 70;
  const preloading = ctx.iina.timers.tick();
  const loading = openNext(ctx);
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([preloading, loading]);
  assert.equal(count(ctx, /player\/playurl/), 2);
  assert.ok(ctx.iina.props["stream-open-filename"].startsWith("edl://"));
});

test("预加载失败时照常解析", async () => {
  const routes = [[/player\/playurl/, [F.PLAYURL, { code: -404, message: "啥都木有" }, F.PLAYURL]]].concat(VIDEO_ROUTES);
  const ctx = await preloadSetup({}, null, routes);
  await playTo(ctx, 0);
  await playTo(ctx, 70);
  assert.equal(warms(ctx).length, 0);
  await openNext(ctx);
  assert.equal(count(ctx, /player\/playurl/), 3);
  assert.ok(ctx.iina.props["stream-open-filename"].startsWith("edl://"));
});

test("下一项换了、设置变了或放得太久时不用预加载的结果", async () => {
  const cases = [
    ["换了下一项", (ctx) => openNext(ctx, PLAIN_URL)],
    ["改了编码偏好", (ctx) => { ctx.prefs.video_codec = "avc"; return openNext(ctx); }],
    ["改了清晰度上限", (ctx) => { ctx.prefs.max_quality = "64"; return openNext(ctx); }],
    ["超过 30 分钟", async (ctx) => {
      const now = Date.now;
      Date.now = () => now() + 31 * 60 * 1000;
      try {
        await openNext(ctx);
      } finally {
        Date.now = now;
      }
    }],
    ["中间打开了别的文件", async (ctx) => {
      ctx.iina.props["stream-open-filename"] = "/tmp/a.mp4";
      await ctx.player.onLoad();
      await openNext(ctx);
    }],
    ["关闭了窗口", async (ctx) => {
      await ctx.player.onWindowClose();
      await openNext(ctx);
    }],
  ];
  for (const [name, act] of cases) {
    const ctx = await preloadSetup();
    await playTo(ctx, 0);
    await playTo(ctx, 70);
    const views = count(ctx, /web-interface\/view/);
    await act(ctx);
    assert.equal(count(ctx, /web-interface\/view/), views + 1, name);
  }
});

test("重新加载当前视频时不用预加载的结果", async () => {
  const ctx = await preloadSetup({}, PLAIN_URL);
  await playTo(ctx, 0);
  await playTo(ctx, 70);
  const views = count(ctx, /web-interface\/view/);
  ctx.player.handleAction({ type: "reload" });
  ctx.iina.props["stream-open-filename"] = PLAIN_URL;
  await ctx.player.onLoad();
  assert.equal(count(ctx, /web-interface\/view/), views + 1);
  assert.equal(ctx.iina.props["file-local-options/start"], "70");
});

test("关闭预加载、下一项是直播或不是 B 站链接、没有下一项时不预加载", async () => {
  const cases = [
    [{ preload_next: false }, null],
    [{}, "https://live.bilibili.com/7734200"],
    [{}, "/Users/me/a.mp4"],
    [{}, ""],
  ];
  for (const [prefs, next] of cases) {
    const ctx = await preloadSetup(prefs, next);
    if (next === "") ctx.iina.props["playlist-count"] = 1;
    await playTo(ctx, 0);
    await playTo(ctx, 70);
    assert.equal(count(ctx, /web-interface\/view/), 1, JSON.stringify([prefs, next]));
    assert.equal(count(ctx, /getRoom/), 0);
    assert.equal(warms(ctx).length, 0);
  }
});

test("从快结束的位置起播时，等过一次检查再预加载，不和起播抢带宽", async () => {
  const ctx = await preloadSetup();
  await playTo(ctx, 100);
  assert.equal(count(ctx, /web-interface\/view/), 1);
  await playTo(ctx, 105);
  assert.equal(count(ctx, /web-interface\/view/), 2);
});

test("按播放速度折算剩余时间", async () => {
  const ctx = await preloadSetup();
  ctx.iina.props.speed = 2;
  await playTo(ctx, 0);
  // 剩余 90 秒按 2 倍速只要 45 秒（1 倍速时不预加载，见上面的用例）
  await playTo(ctx, 30);
  assert.equal(count(ctx, /web-interface\/view/), 2);
});

test("换视频后停止检查", async () => {
  const ctx = await preloadSetup();
  assert.equal(ctx.iina.timers.active(), 1);
  await ctx.player.onEndFile();
  assert.equal(ctx.iina.timers.active(), 0);
});
