// 离线测试用的接口返回数据（按真实接口结构精简）
"use strict";

const VIEW_SINGLE = {
  code: 0,
  data: {
    bvid: "BV1xx411c7mD", aid: 2, title: "测试视频", desc: "简介", pic: "//i0.hdslb.com/a.jpg",
    owner: { name: "UP 主" }, cid: 1001, dimension: { width: 1920, height: 1080, rotate: 0 },
    pages: [{ cid: 1001, page: 1, part: "P1", duration: 120, dimension: { width: 1920, height: 1080, rotate: 0 } }],
  },
};

const VIEW_MULTI = {
  code: 0,
  data: {
    bvid: "BV1multi", aid: 3, title: "多 P 视频", owner: { name: "UP" },
    pages: [
      { cid: 2001, page: 1, part: "第一集", duration: 60, dimension: { width: 1280, height: 720 } },
      { cid: 2002, page: 2, part: "第二集", duration: 70, dimension: { width: 1080, height: 1920, rotate: 0 } },
    ],
  },
};

function dashStream(id, codecid, w, h, host) {
  const codecs = { 7: "avc1.640032", 12: "hev1.1.6.L150.90", 13: "av01.0.13M.08" }[codecid];
  return {
    id, codecid, codecs, width: w, height: h, frameRate: "29.970", bandwidth: id * 10000,
    baseUrl: `https://${host || "cn-gdfs-ct-01-01.bilivideo.com"}/v/${id}-${codecid}.m4s`,
    backupUrl: [`https://upos-sz-mirrorcos.bilivideo.com/v/${id}-${codecid}.m4s`],
  };
}

const PLAYURL = {
  code: 0,
  data: {
    accept_quality: [120, 80, 64, 32],
    accept_description: ["超清 4K", "高清 1080P", "高清 720P", "清晰 480P"],
    dash: {
      video: [
        dashStream(120, 12, 3840, 2160), dashStream(120, 7, 3840, 2160),
        dashStream(80, 7, 1920, 1080), dashStream(80, 12, 1920, 1080), dashStream(80, 13, 1920, 1080),
        dashStream(64, 7, 1280, 720), dashStream(32, 7, 852, 480),
      ],
      audio: [
        { id: 30216, codecs: "mp4a.40.2", bandwidth: 64000, baseUrl: "https://upos-sz-a.bilivideo.com/a64.m4s" },
        { id: 30280, codecs: "mp4a.40.2", bandwidth: 192000, baseUrl: "https://upos-sz-a.bilivideo.com/a192.m4s" },
      ],
      flac: { audio: { id: 30251, codecs: "fLaC", bandwidth: 900000, baseUrl: "https://upos-sz-a.bilivideo.com/flac.m4s" } },
    },
  },
};

const PLAYURL_PREVIEW = {
  code: 0,
  result: {
    is_preview: 1,
    durl: [{ url: "https://cn-xx.bilivideo.com/preview.mp4", backup_url: ["https://upos-sz-x.bilivideo.com/preview.mp4"] }],
  },
};

const SEASON = {
  code: 0,
  result: {
    title: "番剧名",
    episodes: [
      { id: 5001, bvid: "BV1ep1", cid: 7001, aid: 1, title: "1", long_title: "开始", show_title: "第1话 开始", duration: 1440000, dimension: { width: 1920, height: 1080 } },
      { id: 5002, bvid: "BV1ep2", cid: 7002, aid: 2, title: "2", long_title: "继续", show_title: "第2话", badge: "会员", duration: 1440000 },
    ],
  },
};

const DANMAKU_XML = `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver>
<d p="1.5,1,25,16777215,0,0,0,0">第一条</d>
<d p="2.0,5,25,16711680,0,0,0,0">顶部红色</d>
<d p="3.0,4,25,0,0,0,0,0">底部黑色</d>
<d p="4.0,7,25,16777215,0,0,0,0">[高级弹幕]</d>
</i>`;

const PLAYER_V2 = {
  code: 0,
  data: { subtitle: { subtitles: [{ lan: "zh-CN", lan_doc: "中文（中国）", subtitle_url: "//aisubtitle.hdslb.com/sub.json" }] } },
};

const CC_JSON = { body: [{ from: 0.5, to: 2.25, content: "你好" }, { from: 3, to: 4, content: "世界" }] };

const ROOM_BASE = {
  code: 0,
  data: { by_room_ids: { 7734200: { room_id: 7734200, title: "直播标题", uname: "主播" } } },
};

function liveCodec(name, qn, accept, ext, host) {
  return {
    codec_name: name, current_qn: qn, accept_qn: accept, base_url: `/live/${name}-${qn}${ext}?`,
    url_info: [{ host: `https://${host || "cn-live.bilivideo.com"}`, extra: "expires=1" }],
  };
}

const ROOM_PLAY = {
  code: 0,
  data: {
    room_id: 7734200, live_status: 1,
    playurl_info: {
      playurl: {
        g_qn_desc: [{ qn: 10000, desc: "原画" }, { qn: 400, desc: "蓝光" }, { qn: 250, desc: "超清" }, { qn: 150, desc: "高清" }],
        stream: [
          { protocol_name: "http_stream", format: [{ format_name: "flv", codec: [liveCodec("avc", 150, [10000, 400, 250, 150], ".flv")] }] },
          { protocol_name: "http_hls", format: [{ format_name: "ts", codec: [liveCodec("avc", 250, [10000, 250], ".m3u8"), liveCodec("hevc", 400, [10000, 400], ".m3u8")] }] },
        ],
      },
    },
  },
};

module.exports = {
  VIEW_SINGLE, VIEW_MULTI, PLAYURL, PLAYURL_PREVIEW, SEASON, DANMAKU_XML, PLAYER_V2, CC_JSON, ROOM_BASE, ROOM_PLAY, dashStream,
};
