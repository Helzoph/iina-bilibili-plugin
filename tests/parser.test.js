"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBili } = require("../src/common");
const p = require("../src/parser");
const F = require("./fixtures");
const { mockEnv } = require("./harness");

const ANON = { cookie_source: "none" };
const LOGIN = { cookie_source: "manual", cookie: "SESSDATA=s; DedeUserID=42; buvid3=b" };
const SPI = [/finger\/spi/, { code: 0, data: { b_3: "B3" } }];
const ok = (data) => ({ code: 0, data });

function setup(prefs, routes) {
  const env = mockEnv(Object.assign({}, prefs), routes.concat([SPI]));
  // 领取 buvid 的请求与被测逻辑无关，断言时忽略
  env.calls = () => env.requests.filter((q) => !SPI[0].test(q.url));
  const bili = createBili(env);
  return { env, bili, parser: p.createParser(bili) };
}

// ---------------------------------------------------------------- 纯函数

test("cdnOrder 优先 upos 源站，其次普通 CDN，PCDN 与非标端口排最后", () => {
  assert.deepEqual(p.cdnOrder([
    "https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/a",
    "https://cn-gd.bilivideo.com/a",
    null,
    "https://upos-sz-mirrorcos.bilivideo.com/a",
    "https://1.2.3.4:8082/a",
  ]), [
    "https://upos-sz-mirrorcos.bilivideo.com/a",
    "https://cn-gd.bilivideo.com/a",
    "https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/a",
    "https://1.2.3.4:8082/a",
  ]);
  assert.deepEqual(p.cdnOrder([]), []);
});

test("mpvCodec 把 B 站编码字符串映射为 mpv 解码器名", () => {
  assert.equal(p.mpvCodec("avc1.640032"), "h264");
  assert.equal(p.mpvCodec("hev1.1.6"), "hevc");
  assert.equal(p.mpvCodec("hvc1.2"), "hevc");
  assert.equal(p.mpvCodec("dvh1.08.07"), "hevc");
  assert.equal(p.mpvCodec("av01.0.13M"), "av1");
  assert.equal(p.mpvCodec("mp4a.40.2"), "aac");
  assert.equal(p.mpvCodec("fLaC"), "flac");
  assert.equal(p.mpvCodec("ec-3"), "eac3");
  assert.equal(p.mpvCodec("ac-3"), "ac3");
  assert.equal(p.mpvCodec("", 12), "hevc");
  assert.equal(p.mpvCodec("opus"), null);
  assert.equal(p.mpvCodec(undefined), null);
});

test("videoTracks 每档清晰度按编码偏好选一条流，从高到低排列", () => {
  const tracks = p.videoTracks(F.PLAYURL.data, ["avc", "hevc", "av1"]);
  assert.deepEqual(tracks.map((t) => [t.qn, t.name, t.codec]), [
    [120, "超清 4K · AVC", "h264"],
    [80, "高清 1080P · AVC", "h264"],
    [64, "高清 720P · AVC", "h264"],
    [32, "清晰 480P · AVC", "h264"],
  ]);
  assert.equal(tracks[0].url, "https://upos-sz-mirrorcos.bilivideo.com/v/120-7.m4s");
  assert.deepEqual([tracks[0].width, tracks[0].height, tracks[0].fps], [3840, 2160, 30]);
});

test("videoTracks 偏好的编码不存在时退回其他编码", () => {
  const tracks = p.videoTracks(F.PLAYURL.data, ["av1", "hevc", "avc"]);
  assert.deepEqual(tracks.map((t) => t.codec), ["hevc", "av1", "h264", "h264"]);
});

test("videoTracks 缺少清晰度描述时用分辨率命名", () => {
  const tracks = p.videoTracks({ dash: { video: [{ ...F.dashStream(16, 99, 640, 360), codecs: "", frameRate: "" }] } }, ["hevc"]);
  assert.deepEqual(tracks.map((t) => [t.name, t.codec, t.fps]), [["360P", "h264", null]]);
});

test("audioTracks 把无损和杜比排在最前，其余按码率降序", () => {
  const tracks = p.audioTracks({
    ...F.PLAYURL.data.dash,
    dolby: { audio: [{ id: 30250, codecs: "ec-3", bandwidth: 400000, baseUrl: "https://upos-a/dolby.m4s" }] },
  });
  assert.deepEqual(tracks.map((t) => [t.name, t.codec, t.hires]), [
    ["Hi-Res 无损", "flac", true],
    ["杜比全景声", "eac3", true],
    ["192K", "aac", false],
    ["64K", "aac", false],
  ]);
});

test("audioTracks 对未知音质按码率命名，空输入返回空列表", () => {
  assert.equal(p.audioTracks({ audio: [{ id: 1, bandwidth: 96400, codecs: "mp4a", baseUrl: "u" }] })[0].name, "96K");
  assert.deepEqual(p.audioTracks({}), []);
});

test("defaultVideoIndex 取不超过上限的最高档，全部超过时取最低档", () => {
  const tracks = [{ qn: 120 }, { qn: 80 }, { qn: 32 }];
  assert.equal(p.defaultVideoIndex(tracks, 127), 0);
  assert.equal(p.defaultVideoIndex(tracks, 116), 1);
  assert.equal(p.defaultVideoIndex(tracks, 80), 1);
  assert.equal(p.defaultVideoIndex(tracks, 16), 2);
});

// ---------------------------------------------------------------- 视频

test("route 解析单 P 视频为带清晰度与音轨的视频信息", async () => {
  const { parser, env } = setup(ANON, [
    [/web-interface\/view/, F.VIEW_SINGLE],
    [/player\/playurl/, F.PLAYURL],
  ]);
  const r = await parser.route("https://www.bilibili.com/video/BV1xx411c7mD/?t=1:05&spm=x");
  assert.equal(r.type, "video");
  assert.equal(r.title, "测试视频");
  assert.equal(r.author, "UP 主");
  assert.equal(r.start, 65);
  assert.equal(r.cid, "1001");
  assert.equal(r.web, "https://www.bilibili.com/video/BV1xx411c7mD");
  assert.deepEqual(r.video.map((v) => v.name), ["超清 4K · HEVC", "高清 1080P · HEVC", "高清 720P · AVC", "清晰 480P · AVC"]);
  assert.equal(r.videoIndex, 0);
  assert.equal(r.audioIndex, 0);
  assert.equal(r.width, 3840);
  const play = env.requests.find((q) => /playurl/.test(q.url)).url;
  assert.match(play, /bvid=BV1xx411c7mD&cid=1001&qn=127&fnval=4048&fourk=1&try_look=1$/);
});

test("route 已登录时请求播放地址不带 try_look", async () => {
  const { parser, env } = setup(LOGIN, [
    [/web-interface\/view/, F.VIEW_SINGLE],
    [/player\/playurl/, F.PLAYURL],
  ]);
  await parser.route("https://www.bilibili.com/video/BV1xx411c7mD");
  assert.doesNotMatch(env.requests.find((q) => /playurl/.test(q.url)).url, /try_look/);
});

test("route 按清晰度上限与音质偏好选择默认轨道", async () => {
  const { parser } = setup({ ...ANON, max_quality: "64", hires_audio: false }, [
    [/web-interface\/view/, F.VIEW_SINGLE],
    [/player\/playurl/, F.PLAYURL],
  ]);
  const r = await parser.route("https://www.bilibili.com/video/BV1xx411c7mD");
  assert.equal(r.video[r.videoIndex].qn, 64);
  assert.equal(r.audio[r.audioIndex].name, "192K");
  assert.equal(r.width, 1280);
});

test("route 支持 av 号、m 站与大小写不同的 bv 链接", async () => {
  const { parser, env } = setup(ANON, [
    [/web-interface\/view/, F.VIEW_SINGLE],
    [/player\/playurl/, F.PLAYURL],
  ]);
  assert.equal((await parser.route("https://m.bilibili.com/video/av170001")).type, "video");
  assert.match(env.requests.find((q) => /view/.test(q.url)).url, /view\?aid=170001$/);
  await parser.route("https://www.bilibili.com/video/bv1xx411c7mD");
  assert.ok(env.requests.some((q) => /view\?bvid=BV1xx411c7mD$/.test(q.url)));
});

test("route 把未指定分 P 的多 P 视频展开为列表", async () => {
  const { parser } = setup(ANON, [[/web-interface\/view/, F.VIEW_MULTI]]);
  const r = await parser.route("https://www.bilibili.com/video/BV1multi");
  assert.deepEqual(r, {
    type: "list",
    items: [
      { url: "https://www.bilibili.com/video/BV1multi?p=1", title: "P1 第一集", author: "UP", duration: 60 },
      { url: "https://www.bilibili.com/video/BV1multi?p=2", title: "P2 第二集", author: "UP", duration: 70 },
    ],
  });
});

test("route 播放指定的分 P，也可按 cid 选择", async () => {
  const { parser, env } = setup(ANON, [
    [/web-interface\/view/, F.VIEW_MULTI],
    [/player\/playurl/, F.PLAYURL],
  ]);
  const r = await parser.route("https://www.bilibili.com/video/BV1multi?p=2");
  assert.equal(r.title, "多 P 视频 - P2 第二集");
  assert.equal(r.cid, "2002");
  assert.equal(r.web, "https://www.bilibili.com/video/BV1multi?p=2");
  const byCid = await parser.route("https://www.bilibili.com/video/BV1multi?cid=2002");
  assert.equal(byCid.cid, "2002");
  assert.ok(env.requests.filter((q) => /playurl/.test(q.url)).every((q) => /cid=2002/.test(q.url)));
});

test("route 对重定向到番剧页的 BV 号使用番剧取流接口", async () => {
  const view = { code: 0, data: { ...F.VIEW_SINGLE.data, redirect_url: "https://www.bilibili.com/bangumi/play/ep5001" } };
  const { parser, env } = setup(ANON, [
    [/web-interface\/view/, view],
    [/pgc\/player\/web\/playurl/, F.PLAYURL],
  ]);
  assert.equal((await parser.route("https://www.bilibili.com/video/BV1xx411c7mD")).type, "video");
  assert.ok(env.requests.some((q) => /pgc\/player\/web\/playurl\?ep_id=5001&/.test(q.url)));
});

test("route 在没有任何视频流时返回 null 并说明原因", async () => {
  const { parser, bili } = setup(ANON, [
    [/web-interface\/view/, F.VIEW_SINGLE],
    [/player\/playurl/, ok({ accept_quality: [] })],
  ]);
  assert.equal(await parser.route("https://www.bilibili.com/video/BV1xx411c7mD"), null);
  assert.equal(bili.state.lastError, "未找到可播放的视频流");
});

test("route 在视频信息接口失败时返回 null", async () => {
  const { parser } = setup(ANON, [[/web-interface\/view/, { code: -404, message: "啥都木有" }]]);
  assert.equal(await parser.route("https://www.bilibili.com/video/BV1xx411c7mD"), null);
});

// ---------------------------------------------------------------- 番剧

test("route 播放番剧单集，试看片段标记为 preview", async () => {
  const { parser } = setup(ANON, [
    [/pgc\/view\/web\/season/, F.SEASON],
    [/pgc\/player\/web\/playurl/, F.PLAYURL_PREVIEW],
  ]);
  const r = await parser.route("https://www.bilibili.com/bangumi/play/ep5002");
  assert.equal(r.preview, true);
  assert.equal(r.title, "【试看】【会员】番剧名 第2话 继续");
  assert.equal(r.url, "https://upos-sz-x.bilivideo.com/preview.mp4");
  assert.deepEqual(r.video, []);
});

test("route 播放番剧单集时使用 DASH 轨道", async () => {
  const { parser } = setup(ANON, [
    [/pgc\/view\/web\/season/, F.SEASON],
    [/pgc\/player\/web\/playurl/, F.PLAYURL],
  ]);
  const r = await parser.route("https://www.bilibili.com/bangumi/play/ep5001?t=10");
  assert.equal(r.title, "番剧名 第1话 开始");
  assert.equal(r.cid, "7001");
  assert.equal(r.start, 10);
  assert.equal(r.preview, undefined);
  assert.equal(r.video.length, 4);
});

test("route 在番剧中找不到对应集数时返回 null", async () => {
  const { parser, bili } = setup(ANON, [[/pgc\/view\/web\/season/, F.SEASON]]);
  assert.equal(await parser.route("https://www.bilibili.com/bangumi/play/ep9999"), null);
  assert.match(bili.state.lastError, /ep9999/);
});

test("route 把番剧 ss 与 md 链接展开为剧集列表", async () => {
  const { parser, env } = setup(ANON, [
    [/pgc\/view\/web\/season/, F.SEASON],
    [/pgc\/review\/user/, ok({ media: { season_id: 33 } })],
  ]);
  const ss = await parser.route("https://www.bilibili.com/bangumi/play/ss33");
  assert.deepEqual(ss.items.map((i) => [i.url, i.title, i.duration]), [
    ["https://www.bilibili.com/bangumi/play/ep5001", "番剧名 第1话 开始", 1440],
    ["https://www.bilibili.com/bangumi/play/ep5002", "【会员】番剧名 第2话 继续", 1440],
  ]);
  const md = await parser.route("https://www.bilibili.com/bangumi/media/md28");
  assert.equal(md.items.length, 2);
  assert.ok(env.requests.some((q) => /media_id=28/.test(q.url)));
});

test("route 对找不到季度的 md 链接返回 null", async () => {
  const { parser } = setup(ANON, [[/pgc\/review\/user/, ok({ media: {} })]]);
  assert.equal(await parser.route("https://www.bilibili.com/bangumi/media/md1"), null);
});

// ---------------------------------------------------------------- 直播

const LIVE_ROUTES = [
  [/getRoomBaseInfo/, F.ROOM_BASE],
  [/getRoomPlayInfo/, F.ROOM_PLAY],
  [/\/live\//, "200"],
];

test("route 解析直播间，未登录时只列出实际返回的清晰度", async () => {
  const { parser, env } = setup(ANON, LIVE_ROUTES);
  const r = await parser.route("https://live.bilibili.com/7734200?spm=1");
  assert.equal(r.type, "live");
  assert.equal(r.title, "【直播】直播标题");
  assert.equal(r.author, "主播");
  assert.equal(r.url, "https://cn-live.bilivideo.com/live/avc-150.flv?expires=1");
  assert.equal(r.qn, 150);
  assert.equal(r.codec, "http_stream/flv/avc");
  assert.deepEqual(r.qualities.map((q) => q.name), ["蓝光", "超清", "高清"]);
  assert.match(env.requests.find((q) => /getRoomPlayInfo/.test(q.url)).url, /qn=10000/);
  assert.ok(env.requests.filter((q) => /api\.live/.test(q.url)).every((q) => q.referer === "https://live.bilibili.com/"));
});

test("route 已登录时列出所有可选的直播清晰度", async () => {
  const { parser } = setup(LOGIN, LIVE_ROUTES);
  const r = await parser.route("https://live.bilibili.com/h5/7734200");
  assert.deepEqual(r.qualities.map((q) => q.qn), [10000, 400, 250, 150]);
});

test("route 指定直播清晰度时优先选择该清晰度的流", async () => {
  const { parser, env } = setup(LOGIN, LIVE_ROUTES);
  const r = await parser.route("https://live.bilibili.com/7734200", { liveQn: 400 });
  assert.equal(r.qn, 400);
  assert.equal(r.codec, "http_hls/ts/hevc");
  assert.match(env.requests.find((q) => /getRoomPlayInfo/.test(q.url)).url, /qn=400/);
});

test("route 在首选直播流不可用时尝试下一个", async () => {
  const { parser, env } = setup(ANON, [
    [/getRoomBaseInfo/, F.ROOM_BASE],
    [/getRoomPlayInfo/, F.ROOM_PLAY],
    [/\.flv/, "404"],
    [/\/live\//, "200"],
  ]);
  const r = await parser.route("https://live.bilibili.com/7734200");
  assert.equal(r.codec, "http_hls/ts/avc");
  assert.ok(env.logs.some(([lvl, m]) => lvl === "warn" && m.includes("直播流不可用")));
});

test("route 在所有直播流都不可用时返回 null", async () => {
  const { parser, bili } = setup(ANON, [
    [/getRoomBaseInfo/, F.ROOM_BASE],
    [/getRoomPlayInfo/, F.ROOM_PLAY],
    [/\/live\//, "404"],
  ]);
  assert.equal(await parser.route("https://live.bilibili.com/7734200"), null);
  assert.equal(bili.state.lastError, "所有直播流地址都无法访问");
});

test("route 对未开播或没有匹配格式的直播间返回 null", async () => {
  const offline = setup(ANON, [[/getRoomBaseInfo/, F.ROOM_BASE], [/getRoomPlayInfo/, ok({ live_status: 0 })]]);
  assert.equal(await offline.parser.route("https://live.bilibili.com/1"), null);
  assert.match(offline.bili.state.lastError, /未开播/);
  const noMatch = setup({ ...ANON, live_codec: "hevc" }, [
    [/getRoomBaseInfo/, F.ROOM_BASE],
    [/getRoomPlayInfo/, ok({ live_status: 1, playurl_info: { playurl: { stream: [{ protocol_name: "other" }] } } })],
  ]);
  assert.equal(await noMatch.parser.route("https://live.bilibili.com/1"), null);
  assert.equal(noMatch.bili.state.lastError, "没有可用的直播流");
});

test("route 把直播分区展开为直播间列表", async () => {
  const { parser, env } = setup({ ...ANON, max_items: 3 }, [
    [/getRoomList/, (url) => ok({
      count: 100,
      list: [1, 2].map((i) => ({ roomid: Number(url.match(/page=(\d+)/)[1]) * 10 + i, title: "房间" + i, uname: "主播" })),
    })],
  ]);
  const r = await parser.route("https://live.bilibili.com/p/eden/area-tags?parentAreaId=2&areaId=86");
  assert.deepEqual(r.items.map((i) => i.url), ["https://live.bilibili.com/11", "https://live.bilibili.com/12", "https://live.bilibili.com/21"]);
  assert.equal(r.items[0].title, "【直播】房间1");
  assert.match(env.calls()[0].url, /parent_area_id=2&area_id=86/);
});

test("route 对无法识别的直播链接返回 null", async () => {
  const { parser } = setup(ANON, []);
  assert.equal(await parser.route("https://live.bilibili.com/p/html/x"), null);
});

// ---------------------------------------------------------------- 列表

const archive = (n) => ({ bvid: "BV" + n, title: "视频" + n, owner: { name: "UP" + n }, duration: n });

test("route 把热门页按页展开，达到条数上限后停止", async () => {
  const { parser, env } = setup({ ...ANON, max_items: 3 }, [
    [/web-interface\/popular\?/, (url) => {
      const pn = Number(url.match(/pn=(\d+)/)[1]);
      return ok({ list: [archive(pn * 10 + 1), archive(pn * 10 + 2)], no_more: false });
    }],
  ]);
  const r = await parser.route("https://www.bilibili.com/v/popular/all");
  assert.deepEqual(r.items.map((i) => i.title), ["视频11", "视频12", "视频21"]);
  assert.equal(env.requests.filter((q) => /popular\?/.test(q.url)).length, 2);
  assert.deepEqual(r.items[0], { url: "https://www.bilibili.com/video/BV11", title: "视频11", author: "UP11", duration: 11 });
});

test("route 在没有更多内容时停止翻页", async () => {
  const { parser, env } = setup(ANON, [[/web-interface\/popular\?/, ok({ list: [archive(1)], no_more: true })]]);
  assert.equal((await parser.route("https://www.bilibili.com/v/popular")).items.length, 1);
  assert.equal(env.requests.filter((q) => /popular\?/.test(q.url)).length, 1);
});

test("route 请求排行榜时带上排行榜页面的 Referer", async () => {
  const { parser, env } = setup(ANON, [[/ranking\/v2/, ok({ list: [archive(1)] })]]);
  const r = await parser.route("https://www.bilibili.com/v/popular/rank/music");
  assert.equal(r.items.length, 1);
  const req = env.requests.find((q) => /ranking/.test(q.url));
  assert.match(req.url, /rid=3$/);
  assert.equal(req.referer, "https://www.bilibili.com/v/popular/rank/music");
});

test("route 对未知分区的排行榜使用全站榜", async () => {
  const { parser, env } = setup(ANON, [[/ranking\/v2/, ok({ list: [] })]]);
  await parser.route("https://www.bilibili.com/v/popular/rank/unknown");
  assert.match(env.requests.find((q) => /ranking/.test(q.url)).url, /rid=0$/);
});

test("route 展开入站必刷", async () => {
  const { parser } = setup(ANON, [[/popular\/precious/, ok({ list: [archive(1), archive(2)] })]]);
  assert.equal((await parser.route("https://www.bilibili.com/v/popular/history")).items.length, 2);
});

test("route 展开每周必看，未指定期数时取最新一期", async () => {
  const { parser, env } = setup(ANON, [
    [/series\/list/, ok({ list: [{ number: 300 }, { number: 299 }] })],
    [/series\/one/, ok({ list: [archive(1)] })],
  ]);
  assert.equal((await parser.route("https://www.bilibili.com/v/popular/weekly")).items.length, 1);
  assert.match(env.requests.find((q) => /series\/one/.test(q.url)).url, /number=300$/);
  assert.ok(env.requests.filter((q) => /series/.test(q.url)).every((q) => q.referer === "https://www.bilibili.com/v/popular/weekly"));
  await parser.route("https://www.bilibili.com/v/popular/weekly?num=12");
  assert.ok(env.requests.some((q) => /number=12$/.test(q.url)));
});

test("route 在每周必看期数列表失败时返回 null", async () => {
  const { parser } = setup(ANON, [[/series\/list/, ok({ list: [] })]]);
  assert.equal(await parser.route("https://www.bilibili.com/v/popular/weekly"), null);
});

test("route 展开视频搜索结果并去掉高亮标签", async () => {
  const { parser, env } = setup(ANON, [
    [/search\/type/, ok({ numPages: 1, result: [{ bvid: "BV9", title: '<em class="keyword">原神</em>', author: "a", duration: "1:30" }, { title: "no bvid" }] })],
  ]);
  const r = await parser.route("https://search.bilibili.com/all?keyword=%E5%8E%9F%E7%A5%9E&page=2");
  assert.deepEqual(r.items, [{ url: "https://www.bilibili.com/video/BV9", title: "原神", author: "a", duration: 90 }]);
  assert.match(env.calls()[0].url, /search_type=video&keyword=%E5%8E%9F%E7%A5%9E&page=2$/);
});

test("route 展开直播搜索结果，只保留正在直播的房间", async () => {
  const { parser, env } = setup(ANON, [
    [/search\/type/, ok({ result: [{ live_status: 1, roomid: 5, title: "开播", uname: "<em>主</em>播" }, { live_status: 0, roomid: 6 }] })],
  ]);
  const r = await parser.route("https://search.bilibili.com/live?keyword=x");
  assert.deepEqual(r.items, [{ url: "https://live.bilibili.com/5", title: "【直播】开播", author: "主播" }]);
  assert.match(env.calls()[0].url, /search_type=live_room/);
});

test("route 对没有关键字的搜索页返回空列表", async () => {
  const { parser } = setup(ANON, []);
  assert.deepEqual(await parser.route("https://search.bilibili.com/all"), { type: "list", items: [] });
});

test("route 按游标展开 UP 主投稿", async () => {
  const { parser, env } = setup(ANON, [
    [/medialist\/resource\/list/, (url) => {
      const oid = url.match(/oid=(\d*)/)[1];
      return oid === ""
        ? ok({ has_more: true, media_list: [{ id: 1, bv_id: "BV1", title: "t1", upper: { name: "u" }, duration: 5 }] })
        : ok({ has_more: false, media_list: [{ id: 2, bv_id: "BV2", title: "t2", upper: { name: "u" }, duration: 6 }] });
    }],
  ]);
  const r = await parser.route("https://space.bilibili.com/123/video");
  assert.deepEqual(r.items.map((i) => i.url), ["https://www.bilibili.com/video/BV1", "https://www.bilibili.com/video/BV2"]);
  assert.match(env.calls()[1].url, /biz_id=123.*oid=1$/);
});

test("route 展开合集与视频列表", async () => {
  const { parser, env } = setup(ANON, [
    [/seasons_archives_list/, ok({ archives: [archive(1)], page: { page_num: 1, page_size: 30, total: 1 } })],
    [/series\/archives/, ok({ archives: [archive(2), archive(3)], page: { num: 1, size: 30, total: 2 } })],
  ]);
  assert.equal((await parser.route("https://space.bilibili.com/1/channel/collectiondetail?sid=9")).items.length, 1);
  assert.equal((await parser.route("https://space.bilibili.com/1/channel/seriesdetail?sid=8")).items.length, 2);
  assert.equal((await parser.route("https://space.bilibili.com/1/lists/7?type=season")).items.length, 1);
  assert.equal((await parser.route("https://space.bilibili.com/1/lists/6?type=series")).items.length, 2);
  assert.deepEqual(env.calls().map((q) => (q.url.match(/(?:season_id|series_id)=(\d+)/) || [])[1]), ["9", "8", "7", "6"]);
});

test("route 展开收藏夹，跳过失效视频与非视频内容", async () => {
  const { parser, env } = setup(ANON, [
    [/fav\/resource\/list/, ok({ has_more: false, medias: [
      { type: 2, attr: 0, bvid: "BV1", title: "ok", upper: { name: "u" }, duration: 1 },
      { type: 2, attr: 9, bvid: "BV2", title: "失效" },
      { type: 12, attr: 0, bvid: "BV3", title: "音频" },
    ] })],
  ]);
  const r = await parser.route("https://space.bilibili.com/1/favlist?fid=77");
  assert.deepEqual(r.items.map((i) => i.title), ["ok"]);
  assert.match(env.calls()[0].url, /media_id=77/);
  assert.equal((await parser.route("https://www.bilibili.com/medialist/detail/ml77")).items.length, 1);
  assert.equal((await parser.route("https://www.bilibili.com/list/ml77")).items.length, 1);
});

test("route 对未指定收藏夹的链接使用该用户的默认收藏夹", async () => {
  const { parser, env } = setup(ANON, [
    [/folder\/created\/list-all/, ok({ list: [{ id: 55 }, { id: 56 }] })],
    [/fav\/resource\/list/, ok({ has_more: false, medias: [] })],
  ]);
  await parser.route("https://space.bilibili.com/9/favlist");
  assert.match(env.calls()[0].url, /up_mid=9$/);
  assert.match(env.calls()[1].url, /media_id=55/);
});

test("route 展开收藏的合集", async () => {
  const { parser } = setup(ANON, [[/fav\/season\/list/, ok({ medias: [{ bvid: "BV1", title: "s", upper: { name: "u" }, duration: 3 }] })]]);
  assert.equal((await parser.route("https://space.bilibili.com/9/favlist?fid=3&ftype=collect")).items.length, 1);
});

test("需要登录的列表在未登录时返回 null 并提示登录", async () => {
  const urls = [
    "https://www.bilibili.com/watchlater/#/list",
    "https://www.bilibili.com/account/history",
    "https://t.bilibili.com/",
    "https://link.bilibili.com/p/center/index#/user-center/follow/1",
  ];
  for (const url of urls) {
    const { parser, bili, env } = setup(ANON, []);
    assert.equal(await parser.route(url), null, url);
    assert.match(bili.state.lastError, /需要登录/);
    assert.equal(env.calls().length, 0);
  }
});

test("route 展开稍后再看，多 P 视频定位到对应分 P", async () => {
  const { parser } = setup(LOGIN, [
    [/history\/toview/, ok({ list: [{ ...archive(1), videos: 3, page: { page: 2, part: "下" } }, archive(2)] })],
  ]);
  const r = await parser.route("https://www.bilibili.com/list/watchlater");
  assert.deepEqual(r.items.map((i) => [i.url, i.title]), [
    ["https://www.bilibili.com/video/BV1?p=2", "视频1 | 下"],
    ["https://www.bilibili.com/video/BV2", "视频2"],
  ]);
});

test("route 展开历史记录中的视频、番剧和正在直播的房间", async () => {
  const { parser } = setup(LOGIN, [
    [/history\/cursor/, ok({
      cursor: { max: 0, view_at: 0 },
      list: [
        { title: "视频", author_name: "a", duration: 9, videos: 2, show_title: "P2", history: { business: "archive", bvid: "BV1", page: 2 } },
        { title: "番剧", show_title: "第3话", history: { business: "pgc", epid: 3 } },
        { title: "直播", author_name: "b", live_status: 1, history: { business: "live", oid: 8 } },
        { title: "下播", live_status: 0, history: { business: "live", oid: 9 } },
        { title: "专栏", history: { business: "article" } },
      ],
    })],
  ]);
  const r = await parser.route("https://www.bilibili.com/history");
  assert.deepEqual(r.items.map((i) => [i.url, i.title]), [
    ["https://www.bilibili.com/video/BV1?p=2", "视频 | P2"],
    ["https://www.bilibili.com/bangumi/play/ep3", "番剧 第3话"],
    ["https://live.bilibili.com/8", "【直播】直播"],
  ]);
});

test("route 展开动态中的视频和直播", async () => {
  const { parser, env } = setup(LOGIN, [
    [/web-dynamic\/v1\/feed\/all/, ok({
      has_more: false,
      items: [
        { modules: { module_author: { name: "a" }, module_dynamic: { major: { archive: { bvid: "BV1", title: "动态视频", duration_text: "02:00" } } } } },
        { modules: { module_author: { name: "b" }, module_dynamic: { major: { live_rcmd: { content: JSON.stringify({ live_play_info: { live_status: 1, room_id: 6, title: "直播中" } }) } } } } },
        { modules: { module_dynamic: { major: { live_rcmd: { content: "{bad json" } } } } },
        { modules: { module_dynamic: { major: null } } },
        {},
      ],
    })],
  ]);
  const r = await parser.route("https://t.bilibili.com/?tab=video");
  assert.deepEqual(r.items.map((i) => [i.url, i.title, i.duration || null]), [
    ["https://www.bilibili.com/video/BV1", "动态视频", 120],
    ["https://live.bilibili.com/6", "【直播】直播中", null],
  ]);
  assert.match(env.calls()[0].url, /type=video/);
});

test("route 展开关注的直播，遇到未开播的房间即停止", async () => {
  const { parser, env } = setup(LOGIN, [
    [/user\/following/, ok({ totalPage: 5, list: [{ live_status: 1, roomid: 1, title: "t", uname: "u" }, { live_status: 0, roomid: 2 }] })],
  ]);
  const r = await parser.route("https://link.bilibili.com/p/center/index");
  assert.deepEqual(r.items.map((i) => i.url), ["https://live.bilibili.com/1"]);
  assert.equal(env.calls().length, 1);
});

test("route 把首页展开为推荐视频与直播，并去掉重复的条目", async () => {
  const { parser } = setup({ ...ANON, max_items: 3 }, [
    [/top\/feed\/rcmd/, ok({ item: [
      { goto: "av", ...archive(1) },
      { goto: "av", ...archive(1) },
      { goto: "live", id: 3, room_info: { room_id: 7 }, title: "直播", owner: { name: "o" } },
      { goto: "ad" },
    ] })],
  ]);
  const r = await parser.route("https://www.bilibili.com/");
  assert.deepEqual(r.items.map((i) => i.url), ["https://www.bilibili.com/video/BV1", "https://live.bilibili.com/7"]);
});

test("route 通过 b23.tv 短链跳转后再解析", async () => {
  const { parser } = setup(ANON, [
    [/b23\.tv\/good/, "https://www.bilibili.com/v/popular/history"],
    [/b23\.tv\/loop/, "https://b23.tv/loop"],
    [/popular\/precious/, ok({ list: [archive(1)] })],
  ]);
  assert.equal((await parser.route("https://b23.tv/good")).items.length, 1);
  assert.equal(await parser.route("https://b23.tv/loop"), null);
});

test("route 对不支持的链接返回 null", async () => {
  const { parser, env } = setup(ANON, []);
  for (const url of ["", "ftp://x", "https://www.bilibili.com/read/cv1", "https://game.bilibili.com/", "https://space.bilibili.com/"]) {
    assert.equal(await parser.route(url), null, url);
  }
  assert.equal(env.calls().length, 0);
});

// ---------------------------------------------------------------- 封面（侧边栏浏览用）

test("route 的列表条目带上封面，// 开头的地址补全为 https", async () => {
  const { parser } = setup(LOGIN, [
    [/top\/feed\/rcmd/, ok({ item: [
      { goto: "av", ...archive(1), pic: "http://i0.hdslb.com/a.jpg" },
      { goto: "live", room_info: { room_id: 7 }, title: "直播", pic: "https://i0.hdslb.com/r.jpg" },
    ] })],
    [/search\/type\?search_type=video/, ok({ result: [{ bvid: "BV9", title: "t", pic: "//i1.hdslb.com/s.jpg" }] })],
    [/search\/type\?search_type=live_room/, ok({ result: [{ live_status: 1, roomid: 5, title: "t", user_cover: "//i0.hdslb.com/u.jpg", cover: "//i0.hdslb.com/k.jpg" }] })],
    [/user\/following/, ok({ list: [{ live_status: 1, roomid: 1, title: "t", room_cover: "", face: "https://i0.hdslb.com/f.jpg" }] })],
    [/getRoomList/, ok({ list: [{ roomid: 2, title: "t", cover: "https://i0.hdslb.com/c.jpg" }] })],
    [/web-dynamic\/v1\/feed\/all/, ok({ items: [
      { modules: { module_dynamic: { major: { archive: { bvid: "BV1", title: "v", cover: "http://i0.hdslb.com/d.jpg" } } } } },
      { modules: { module_dynamic: { major: { live_rcmd: { content: JSON.stringify({ live_play_info: { live_status: 1, room_id: 6, title: "l", cover: "http://i0.hdslb.com/l.jpg" } }) } } } } },
    ] })],
    [/history\/cursor/, ok({ cursor: { max: 0 }, list: [{ title: "h", cover: "http://i0.hdslb.com/h.jpg", history: { business: "archive", bvid: "BV3" } }] })],
  ]);
  const covers = async (url) => (await parser.route(url)).items.map((i) => i.cover);
  assert.deepEqual(await covers("https://www.bilibili.com/"), ["https://i0.hdslb.com/a.jpg", "https://i0.hdslb.com/r.jpg"]);
  assert.deepEqual(await covers("https://search.bilibili.com/all?keyword=x"), ["https://i1.hdslb.com/s.jpg"]);
  assert.deepEqual(await covers("https://search.bilibili.com/live?keyword=x"), ["https://i0.hdslb.com/u.jpg"]);
  assert.deepEqual(await covers("https://link.bilibili.com/"), ["https://i0.hdslb.com/f.jpg"]);
  assert.deepEqual(await covers("https://live.bilibili.com/p/eden/area-tags?parentAreaId=2"), ["https://i0.hdslb.com/c.jpg"]);
  assert.deepEqual(await covers("https://t.bilibili.com/"), ["https://i0.hdslb.com/d.jpg", "https://i0.hdslb.com/l.jpg"]);
  assert.deepEqual(await covers("https://www.bilibili.com/history"), ["https://i0.hdslb.com/h.jpg"]);
});

test("route 的列表条目没有封面时不带 cover 字段", async () => {
  const { parser } = setup(ANON, [[/web-interface\/popular\?/, ok({ list: [archive(1)], no_more: true })]]);
  const r = await parser.route("https://www.bilibili.com/v/popular");
  assert.equal("cover" in r.items[0], false);
});
