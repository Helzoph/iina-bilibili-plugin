// 弹幕转换：把 B 站 XML 弹幕分配好轨道后写成 ASS 字幕，交给 mpv 自带的 libass 显示
"use strict";

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// ASS 里 { } 开启样式标签、\ 开启转义，换成全角字符原样显示
function escapeAss(s) {
  return s.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/[\r\n]+/g, " ");
}

// 粗略估算文字宽度：ASCII 按半个字宽，其余（中日韩文字、emoji）按一个字宽
function textWidth(s, size) {
  let units = 0;
  for (const ch of s) units += ch.codePointAt(0) < 0x80 ? 0.6 : 1;
  return units * size;
}

function assTime(t) {
  const cs = Math.round(t * 100);
  const pad = (n) => String(n).padStart(2, "0");
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

// 滚动弹幕的轨道是否空闲：前一条已经完全进入画面，并且新弹幕的头部抵达左边缘时前一条已经离开
function scrollLaneFree(last, t, speed, screenW, duration) {
  if (!last) return true;
  return t >= last.t + last.width / last.speed && t + screenW / speed >= last.t + duration;
}

// xml: B 站弹幕 XML；videoW/videoH: 视频分辨率，用于设置画布比例；cfg: config().danmaku
// 返回 { ass, count }
function toAss(xml, videoW, videoH, cfg) {
  const H = 1080;
  // 画布与视频同宽高比，避免竖屏视频上的文字被横向拉伸
  const W = Math.round(H * (videoW || 16) / (videoH || 9));
  const fontSize = Math.round(cfg.fontSize);
  const laneHeight = Math.round(fontSize * 1.15);
  const laneCount = Math.max(1, Math.floor(H * cfg.displayArea / laneHeight));
  const alpha = Math.round((1 - cfg.opacity) * 255).toString(16).toUpperCase().padStart(2, "0");

  const comments = [];
  const re = /<d p="([^"]*)">([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1].match(/^([\d.]+),(\d+),(\d+),(\d+)/);
    if (!a) continue;
    const mode = Number(a[2]);
    // 1~3 滚动、4 底部、5 顶部、6 逆向；7 以上是高级/代码弹幕，无法用 ASS 还原
    if (mode > 6) continue;
    comments.push({ t: Number(a[1]), mode, size: Number(a[3]), color: Number(a[4]), text: unescapeXml(m[2]) });
  }
  // 稳定排序，同一时刻的弹幕保持原顺序
  comments.sort((x, y) => x.t - y.t);

  const scroll = [], top = [], bottom = [];
  const events = [];
  for (const c of comments) {
    const fs = Math.round(fontSize * c.size / 25);
    let tags = "";
    if (fs !== fontSize) tags += "\\fs" + fs;
    if (c.color !== 0xffffff) {
      const r = (c.color >> 16) & 255, g = (c.color >> 8) & 255, b = c.color & 255;
      const hex = (n) => n.toString(16).toUpperCase().padStart(2, "0");
      tags += `\\c&H${hex(b)}${hex(g)}${hex(r)}&`;
      // 深色文字配白色描边，否则在暗画面上看不清
      if (r * 0.299 + g * 0.587 + b * 0.114 < 50) tags += "\\3c&HFFFFFF&";
    }

    let layer = null, finish = 0;
    if (c.mode === 4 || c.mode === 5) {
      const lanes = c.mode === 5 ? top : bottom;
      for (let i = 0; i < laneCount; i++) {
        if (lanes[i] === undefined || lanes[i] <= c.t) {
          lanes[i] = c.t + cfg.fixedTime;
          const y = i * laneHeight;
          tags = (c.mode === 5 ? `\\an8\\pos(${Math.floor(W / 2)},${y})` : `\\an2\\pos(${Math.floor(W / 2)},${H - y})`) + tags;
          layer = 1;
          finish = c.t + cfg.fixedTime;
          break;
        }
      }
    } else {
      const width = textWidth(c.text, fs);
      const speed = (W + width) / cfg.scrollTime;
      for (let i = 0; i < laneCount; i++) {
        if (scrollLaneFree(scroll[i], c.t, speed, W, cfg.scrollTime)) {
          scroll[i] = { t: c.t, width, speed };
          const y = i * laneHeight;
          // 逆向弹幕从左往右移动
          const move = c.mode === 6 ? `\\move(${-Math.ceil(width)},${y},${W},${y})` : `\\move(${W},${y},${-Math.ceil(width)},${y})`;
          tags = move + tags;
          layer = 0;
          finish = c.t + cfg.scrollTime;
          break;
        }
      }
    }
    // 所有轨道都被占满时丢弃这条弹幕，避免文字互相重叠
    if (layer !== null) {
      events.push(`Dialogue: ${layer},${assTime(c.t)},${assTime(finish)},Danmaku,,0,0,0,,{${tags}}${escapeAss(c.text)}`);
    }
  }

  const font = cfg.font || "PingFang SC";
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: " + W,
    "PlayResY: " + H,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
      + "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Danmaku,${font},${fontSize},&H${alpha}FFFFFF,&H${alpha}FFFFFF,&H${alpha}000000,&H${alpha}000000,${cfg.bold ? -1 : 0},0,0,0,100,100,0,0,1,1.5,0,7,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  return { ass: header.join("\n") + "\n" + events.join("\n") + "\n", count: events.length };
}

module.exports = { toAss, textWidth, assTime };
