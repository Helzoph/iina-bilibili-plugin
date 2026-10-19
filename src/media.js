// 生成交给 mpv 的播放地址与字幕内容，均为纯函数，便于测试
"use strict";

// EDL 字符串转义：%字节长度%原文
function edlEscape(s) {
  return "%" + utf8Length(s) + "%" + s;
}

// IINA 的 JavaScriptCore 环境没有 Buffer，手动计算 UTF-8 字节数
function utf8Length(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

// 每个清晰度、每条音轨各占一个 !new_stream 分区，并用 delay_open 延迟打开：
// 只有被选中的轨道才会连接 CDN，其余轨道不产生流量；在 IINA 的“视频轨道/音频轨道”菜单里显示为带名称的轨道，
// 切换时 mpv 从当前进度无缝继续
function videoEdl(info) {
  const parts = [];
  for (const v of info.video) {
    let header = `!delay_open,media_type=video,codec=${v.codec}`;
    if (v.width && v.height) header += `,w=${v.width},h=${v.height}`;
    if (v.fps) header += `,fps=${v.fps}`;
    parts.push(`!new_stream;!no_clip;${header};!track_meta,title=${edlEscape(v.name)};${edlEscape(v.url)}`);
  }
  for (const a of info.audio) {
    parts.push(`!new_stream;!no_clip;!delay_open,media_type=audio,codec=${a.codec};!track_meta,title=${edlEscape(a.name)};${edlEscape(a.url)}`);
  }
  return "edl://" + parts.join(";");
}

// 列表页展开为 m3u，mpv 会把其中每一项加入播放列表
function playlistM3u(items) {
  const lines = ["#EXTM3U"];
  for (const it of items) {
    if (it.title) lines.push(`#EXTINF:${Math.round(it.duration || 0) || -1},${String(it.title).replace(/[\r\n]+/g, " ")}`);
    lines.push(it.url);
  }
  return "memory://" + lines.join("\n");
}

function srtTime(t) {
  const ms = Math.round(t * 1000);
  const pad = (n, w) => String(n).padStart(w || 2, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

// B 站 CC 字幕 JSON（{ body: [{ from, to, content }] }）转 SRT
function ccToSrt(obj) {
  const body = obj && Array.isArray(obj.body) ? obj.body : [];
  return body.map((line, i) => `${i + 1}\n${srtTime(line.from)} --> ${srtTime(line.to)}\n${line.content}\n`).join("\n");
}

module.exports = { edlEscape, videoEdl, playlistM3u, ccToSrt, srtTime };
