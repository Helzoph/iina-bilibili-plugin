"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { toAss, textWidth, assTime } = require("../src/danmaku");
const { edlEscape, videoEdl, playlistM3u, ccToSrt, srtTime } = require("../src/media");
const { DANMAKU_XML, CC_JSON } = require("./fixtures");

const CFG = { fontSize: 50, opacity: 0.8, displayArea: 1, scrollTime: 10, fixedTime: 5, bold: true, font: "" };
const d = (t, mode, color, text, size) => `<d p="${t},${mode},${size || 25},${color === undefined ? 16777215 : color},0,0,0,0">${text}</d>`;
const xml = (...items) => `<i>${items.join("")}</i>`;
const dialogues = (ass) => ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

// ---------------------------------------------------------------- 弹幕

test("assTime 格式化为 h:mm:ss.cc", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(3723.456), "1:02:03.46");
  assert.equal(assTime(59.999), "0:01:00.00");
});

test("textWidth 中文按整字宽，ASCII 按 0.6", () => {
  assert.equal(textWidth("中文", 10), 20);
  assert.equal(textWidth("ab", 10), 12);
  assert.equal(textWidth("", 10), 0);
});

test("toAss 对空输入生成只有文件头的字幕", () => {
  const { ass, count } = toAss("", 1920, 1080, CFG);
  assert.equal(count, 0);
  assert.match(ass, /\[Events\]/);
  assert.equal(dialogues(ass).length, 0);
});

test("toAss 转换样例弹幕并丢弃高级弹幕", () => {
  const { ass, count } = toAss(DANMAKU_XML, 1920, 1080, CFG);
  assert.equal(count, 3);
  assert.ok(!ass.includes("高级弹幕"));
  assert.match(ass, /PlayResX: 1920\nPlayResY: 1080/);
  // 不透明度 0.8 对应 alpha 33，默认字体为苹方，粗体为 -1
  assert.match(ass, /Style: Danmaku,PingFang SC,50,&H33FFFFFF,/);
  assert.match(ass, /,-1,0,0,0,100,100/);
});

test("toAss 滚动弹幕从右向左移动，逆向弹幕从左向右", () => {
  const { ass } = toAss(xml(d(1, 1, undefined, "ab"), d(1, 6, undefined, "cd")), 1920, 1080, CFG);
  const [normal, reverse] = dialogues(ass);
  assert.match(normal, /\\move\(1920,0,-60,0\)/);
  assert.match(reverse, /\\move\(-60,\d+,1920,\d+\)/);
  assert.match(normal, /^Dialogue: 0,0:00:01\.00,0:00:11\.00,/);
});

test("toAss 顶部和底部弹幕居中固定显示", () => {
  const { ass } = toAss(xml(d(2, 5, undefined, "顶"), d(2, 4, undefined, "底")), 1920, 1080, CFG);
  const [top, bottom] = dialogues(ass);
  assert.match(top, /^Dialogue: 1,0:00:02\.00,0:00:07\.00,.*\\an8\\pos\(960,0\)/);
  assert.match(bottom, /\\an2\\pos\(960,1080\)/);
});

test("toAss 同时出现的弹幕分配到不同轨道，空出后复用", () => {
  const { ass } = toAss(xml(d(0, 5, undefined, "a"), d(1, 5, undefined, "b"), d(6, 5, undefined, "c")), 1920, 1080, CFG);
  const ys = dialogues(ass).map((l) => Number(l.match(/\\pos\(\d+,(\d+)\)/)[1]));
  // 行高 = round(50 * 1.15) = 57（浮点结果为 57.4999…）；第三条出现时第一条已经结束
  assert.deepEqual(ys, [0, 57, 0]);
});

test("toAss 在轨道全部占满时丢弃弹幕", () => {
  // 显示区域只够一条轨道
  const cfg = { ...CFG, displayArea: 0.06 };
  const { count } = toAss(xml(d(0, 1, undefined, "一"), d(0.1, 1, undefined, "二"), d(0.2, 5, undefined, "三"), d(0.3, 5, undefined, "四")), 1920, 1080, cfg);
  assert.equal(count, 2);
});

test("toAss 写入颜色、字号，并给深色文字加白色描边", () => {
  const { ass } = toAss(xml(d(0, 1, 0xff0000, "红"), d(0, 1, 0x000000, "黑"), d(0, 1, undefined, "大", 36)), 1920, 1080, CFG);
  const [red, black, big] = dialogues(ass);
  assert.match(red, /\\c&H0000FF&/);
  assert.ok(!red.includes("\\3c"));
  assert.match(black, /\\c&H000000&\\3c&HFFFFFF&/);
  assert.match(big, /\\fs72/);
  assert.ok(!big.includes("\\c&"));
});

test("toAss 还原 XML 实体并转义 ASS 特殊字符", () => {
  const { ass } = toAss(xml(d(0, 1, undefined, "&lt;{\\N}&gt;&amp;&#x1F600;&#33;")), 1920, 1080, CFG);
  assert.ok(dialogues(ass)[0].endsWith("<｛＼N｝>&😀!"));
});

test("toAss 按时间排序乱序的弹幕", () => {
  const { ass } = toAss(xml(d(9, 1, undefined, "后"), d(3, 1, undefined, "前")), 1920, 1080, CFG);
  assert.deepEqual(dialogues(ass).map((l) => l.slice(-1)), ["前", "后"]);
});

test("toAss 竖屏视频的画布宽度随宽高比缩小，并使用自定义字体", () => {
  const { ass } = toAss("", 1080, 1920, { ...CFG, font: "Heiti SC", bold: false });
  assert.match(ass, /PlayResX: 608\n/);
  assert.match(ass, /Style: Danmaku,Heiti SC,50,.*,0,0,0,0,100,100/);
});

test("toAss 缺少分辨率时按 16:9 处理", () => {
  assert.match(toAss("", undefined, undefined, CFG).ass, /PlayResX: 1920\n/);
});

// ---------------------------------------------------------------- 媒体

test("edlEscape 使用 UTF-8 字节长度", () => {
  assert.equal(edlEscape("abc"), "%3%abc");
  assert.equal(edlEscape("高清"), "%6%高清");
  assert.equal(edlEscape("é😀"), "%6%é😀");
  assert.equal(edlEscape(""), "%0%");
});

test("videoEdl 为每条轨道生成延迟打开的分区", () => {
  const edl = videoEdl({
    video: [
      { name: "4K · HEVC", url: "https://v/1.m4s?a=1;b", codec: "hevc", width: 3840, height: 2160, fps: 60 },
      { name: "480P", url: "https://v/2.m4s", codec: "h264" },
    ],
    audio: [{ name: "192K", url: "https://a/1.m4s", codec: "aac" }],
  });
  const parts = edl.replace(/^edl:\/\//, "").split("!new_stream;").filter(Boolean);
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "!no_clip;!delay_open,media_type=video,codec=hevc,w=3840,h=2160,fps=60;!track_meta,title=%10%4K · HEVC;%21%https://v/1.m4s?a=1;b;");
  assert.equal(parts[1], "!no_clip;!delay_open,media_type=video,codec=h264;!track_meta,title=%4%480P;%15%https://v/2.m4s;");
  assert.equal(parts[2], "!no_clip;!delay_open,media_type=audio,codec=aac;!track_meta,title=%4%192K;%15%https://a/1.m4s");
});

test("playlistM3u 生成 memory:// 列表，标题中的换行替换为空格", () => {
  const m3u = playlistM3u([
    { url: "https://www.bilibili.com/video/BV1", title: "第一\n行", duration: 61.4 },
    { url: "https://live.bilibili.com/1", title: "直播" },
    { url: "https://x/no-title" },
  ]);
  assert.equal(m3u, "memory://#EXTM3U\n#EXTINF:61,第一 行\nhttps://www.bilibili.com/video/BV1\n#EXTINF:-1,直播\nhttps://live.bilibili.com/1\nhttps://x/no-title");
});

test("playlistM3u 对空列表只输出文件头", () => {
  assert.equal(playlistM3u([]), "memory://#EXTM3U");
});

test("srtTime 格式化为 hh:mm:ss,mmm", () => {
  assert.equal(srtTime(0), "00:00:00,000");
  assert.equal(srtTime(3723.0456), "01:02:03,046");
});

test("ccToSrt 转换字幕正文", () => {
  assert.equal(ccToSrt(CC_JSON), "1\n00:00:00,500 --> 00:00:02,250\n你好\n\n2\n00:00:03,000 --> 00:00:04,000\n世界\n");
});

test("ccToSrt 对缺少 body 的输入返回空串", () => {
  assert.equal(ccToSrt(null), "");
  assert.equal(ccToSrt({}), "");
  assert.equal(ccToSrt({ body: "x" }), "");
});
