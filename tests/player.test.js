"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBili, REFERER, LIVE_REFERER, UA } = require("../src/common");
const { createParser } = require("../src/parser");
const { createPlayer, DANMAKU_TITLE } = require("../src/player");
const F = require("./fixtures");
const { mockEnv, fakeIina } = require("./harness");

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
  assert.deepEqual(ctx.player.snapshot(), { login: "检查中…", codec: "av1", loading: false, error: "", item: null });
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
