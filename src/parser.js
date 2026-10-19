// 链接解析：把 B 站视频、番剧、直播链接解析成可播放的媒体信息，把空间、收藏夹、排行榜、搜索等页面展开成列表。
// 列表条目仍是 B 站网页链接，轮到播放时再解析，避免播放地址过期。
// route(url) 的返回值：
//   null                                    不支持的链接
//   { type: "list", items: [{ url, title }] }
//   { type: "video", ... } 见 resolveStream
//   { type: "live", ... }  见 live
"use strict";

const { str, query, https, seconds, clean } = require("./common");

const VIDEO_CODECS = { avc: 7, hevc: 12, av1: 13 };
const CODEC_LABELS = { 7: "AVC", 12: "HEVC", 13: "AV1" };
const LIVE_FORMATS = { flv: ["http_stream", "flv"], ts: ["http_hls", "ts"], fmp4: ["http_hls", "fmp4"] };
const AUDIO_NAMES = { 30216: "64K", 30232: "132K", 30280: "192K", 30250: "杜比全景声", 30251: "Hi-Res 无损" };

const RANK_RIDS = {
  all: 0, guochuang: 168, douga: 1, music: 3, dance: 129, game: 4, knowledge: 36, tech: 188,
  sports: 234, car: 223, life: 160, food: 211, animal: 217, kichiku: 119, fashion: 155, ent: 5, cinephile: 181,
};

// 优先选用 upos 源站：PCDN（mcdn、:8082/:4483 等非标端口）在海外与部分网络下经常连不上
function cdnOrder(urls) {
  const score = (u) => {
    if (/^https?:\/\/upos-/.test(u)) return 0;
    if (!/mcdn/.test(u) && !/^https?:\/\/[^/]+:\d+\//.test(u)) return 1;
    return 2;
  };
  return urls.filter(Boolean).map((u, i) => [u, score(u), i]).sort((x, y) => x[1] - y[1] || x[2] - y[2]).map((x) => x[0]);
}

function streamUrls(s) {
  return [s.baseUrl || s.base_url].concat(s.backupUrl || s.backup_url || []);
}

// mpv 解码器名称，EDL 的 delay_open 需要它来初始化轨道
function mpvCodec(codecs, codecid) {
  const c = str(codecs).toLowerCase();
  if (c.startsWith("avc") || codecid === 7) return "h264";
  if (c.startsWith("hev") || c.startsWith("hvc") || c.startsWith("dvh") || codecid === 12) return "hevc";
  if (c.startsWith("av01") || codecid === 13) return "av1";
  if (c.startsWith("mp4a")) return "aac";
  if (c.startsWith("flac") || c === "flac") return "flac";
  if (c.startsWith("ec-3")) return "eac3";
  if (c.startsWith("ac-3")) return "ac3";
  return null;
}

// 每个清晰度取一条视频流：按配置的编码顺序挑选，返回按清晰度从高到低排序的列表
function videoTracks(play, codecs) {
  const names = {};
  (play.accept_quality || []).forEach((qn, i) => { names[qn] = (play.accept_description || [])[i]; });
  const byQn = {};
  for (const v of play.dash.video || []) (byQn[v.id] = byQn[v.id] || []).push(v);
  const rank = (v) => {
    const name = Object.keys(VIDEO_CODECS).find((k) => VIDEO_CODECS[k] === v.codecid);
    const i = codecs.indexOf(name);
    return i < 0 ? 99 : i;
  };
  return Object.keys(byQn).map(Number).sort((a, b) => b - a).map((qn) => {
    const v = byQn[qn].slice().sort((a, b) => rank(a) - rank(b))[0];
    const codecLabel = CODEC_LABELS[v.codecid];
    return {
      qn,
      name: (names[qn] || (v.height + "P")) + (codecLabel ? " · " + codecLabel : ""),
      url: cdnOrder(streamUrls(v))[0],
      codec: mpvCodec(v.codecs, v.codecid) || "h264",
      width: v.width, height: v.height,
      fps: Math.round(Number(v.frameRate || v.frame_rate) || 0) || null,
    };
  });
}

// 普通音轨按码率从高到低，Hi-Res 无损和杜比全景声排在最前
function audioTracks(dash) {
  const list = [];
  if (dash.flac && dash.flac.audio) list.push(dash.flac.audio);
  if (dash.dolby && Array.isArray(dash.dolby.audio)) list.push(...dash.dolby.audio);
  const hires = list.length;
  const normal = (dash.audio || []).slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  return list.concat(normal).map((a, i) => ({
    id: a.id,
    name: AUDIO_NAMES[a.id] || (Math.round((a.bandwidth || 0) / 1000) + "K"),
    url: cdnOrder(streamUrls(a))[0],
    codec: mpvCodec(a.codecs) || "aac",
    hires: i < hires,
  }));
}

// 默认清晰度：不超过上限的最高一档；全部高于上限时取最低一档
function defaultVideoIndex(tracks, maxQuality) {
  const i = tracks.findIndex((t) => t.qn <= maxQuality);
  return i >= 0 ? i : tracks.length - 1;
}

function createParser(bili) {
  const limit = () => bili.config().maxItems;

  // 封面只给侧边栏浏览用：统一成 https，没有时不带该字段
  function withCover(item, cover) {
    const c = str(cover).replace(/^(https?:)?\/\//, "https://");
    if (/^https:\/\//.test(c)) item.cover = c;
    return item;
  }

  function videoItem(bvid, title, author, duration, cover) {
    return withCover({ url: "https://www.bilibili.com/video/" + bvid, title: clean(title), author, duration: seconds(duration) }, cover);
  }

  function liveItem(roomId, title, author, cover) {
    return withCover({ url: "https://live.bilibili.com/" + roomId, title: "【直播】" + clean(title), author }, cover);
  }

  // ---------------------------------------------------------------- 视频

  // 统一使用不带 /wbi/ 的接口路径：携带 buvid 却未做 WBI 签名时请求 /wbi/ 接口会被随机风控。
  // try_look=1 让未登录用户也能拿到 720P/1080P，但已登录时带上它反而会被限制在 1080P，所以只在未登录时使用
  // info: { bvid, cid, epId, title, author, web, width, height, start }
  async function resolveStream(info) {
    const cfg = bili.config().video;
    const params = `cid=${info.cid}&qn=127&fnval=4048&fourk=1` + ((await bili.uid()) ? "" : "&try_look=1");
    const play = info.epId
      ? await bili.api(`https://api.bilibili.com/pgc/player/web/playurl?ep_id=${info.epId}&${params}`)
      : await bili.api(`https://api.bilibili.com/x/player/playurl?bvid=${info.bvid}&${params}`);
    if (!play) return null;

    const result = {
      type: "video", title: info.title, author: info.author, web: info.web, start: info.start,
      bvid: info.bvid, cid: info.cid, width: info.width, height: info.height,
      video: [], audio: [], videoIndex: 0, audioIndex: 0, url: null,
    };
    if (play.dash && play.dash.video && play.dash.video.length) {
      result.video = videoTracks(play, cfg.codecs);
      result.audio = audioTracks(play.dash);
      result.videoIndex = defaultVideoIndex(result.video, cfg.maxQuality);
      const firstNormal = result.audio.findIndex((a) => !a.hires);
      result.audioIndex = cfg.hiresAudio || firstNormal < 0 ? 0 : firstNormal;
      const v = result.video[result.videoIndex];
      result.width = v.width || result.width;
      result.height = v.height || result.height;
    } else if (play.durl && play.durl[0]) {
      // 番剧试看片段等只提供音视频合一的 mp4/flv
      const d = play.durl[0];
      result.url = cdnOrder([d.url].concat(d.backup_url || []))[0];
    } else {
      bili.fail("未找到可播放的视频流，返回字段: " + Object.keys(play).sort().join(","), "未找到可播放的视频流");
      return null;
    }
    if (play.is_preview === 1 || (info.epId && play.durl && !play.dash)) {
      result.title = "【试看】" + (result.title || "");
      result.preview = true;
    }
    return result;
  }

  async function video(url, id) {
    const key = id.startsWith("BV") ? "bvid=" + id : "aid=" + id.replace(/^av/, "");
    const data = await bili.api("https://api.bilibili.com/x/web-interface/view?" + key);
    if (!data) return null;
    const pages = data.pages || [];
    const p = Number(query(url, "p")) || null;
    const cid = query(url, "cid");

    // 未指定分 P 的多 P 视频展开为分 P 列表
    if (!p && !cid && pages.length > 1) {
      return {
        type: "list",
        items: pages.map((page) => ({
          url: `https://www.bilibili.com/video/${data.bvid}?p=${page.page}`,
          title: `P${page.page} ${page.part}`,
          author: data.owner && data.owner.name,
          duration: page.duration,
        })),
      };
    }

    let page = pages[(p || 1) - 1] || pages[0];
    if (cid) page = pages.find((pg) => String(pg.cid) === cid) || page;
    if (!page) return null;

    const title = pages.length > 1 ? `${data.title} - P${page.page} ${page.part}` : data.title;
    const dim = page.dimension || data.dimension || {};
    const [w, h] = dim.rotate === 1 ? [dim.height, dim.width] : [dim.width, dim.height];
    // 番剧/电影的 BV 号会重定向到番剧页面，需要使用番剧取流接口
    const ep = str(data.redirect_url).match(/bangumi\/play\/ep(\d+)/);
    return resolveStream({
      bvid: data.bvid, cid: String(page.cid), epId: ep && ep[1], title,
      author: data.owner && data.owner.name,
      web: `https://www.bilibili.com/video/${data.bvid}` + (pages.length > 1 ? `?p=${page.page}` : ""),
      width: w, height: h, start: seconds(query(url, "t")),
    });
  }

  // ---------------------------------------------------------------- 番剧

  function episodeTitle(seasonTitle, ep) {
    let name = ep.show_title || ep.title || "";
    if (ep.long_title && !name.includes(ep.long_title)) name += " " + ep.long_title;
    let title = seasonTitle ? seasonTitle + " " + name : name;
    if (ep.badge) title = "【" + ep.badge + "】" + title;
    return title;
  }

  async function seasonList(params) {
    const data = await bili.api("https://api.bilibili.com/pgc/view/web/season?" + params);
    if (!data) return null;
    return {
      type: "list",
      items: (data.episodes || []).map((ep) => ({
        url: "https://www.bilibili.com/bangumi/play/ep" + ep.id,
        title: episodeTitle(data.title, ep),
        duration: ep.duration && ep.duration / 1000,
      })),
    };
  }

  async function episode(url, epId) {
    const data = await bili.api("https://api.bilibili.com/pgc/view/web/season?ep_id=" + epId);
    if (!data) return null;
    const ep = (data.episodes || []).find((e) => String(e.id) === epId);
    if (!ep) {
      bili.fail("番剧中找不到 ep" + epId);
      return null;
    }
    const dim = ep.dimension || {};
    return resolveStream({
      epId, bvid: ep.bvid, cid: String(ep.cid), title: episodeTitle(data.title, ep),
      author: data.up_info && data.up_info.uname,
      web: "https://www.bilibili.com/bangumi/play/ep" + epId,
      width: dim.width, height: dim.height, start: seconds(query(url, "t")),
    });
  }

  async function mdToSs(md) {
    const data = await bili.api("https://api.bilibili.com/pgc/review/user?media_id=" + md);
    return data && data.media && data.media.season_id;
  }

  // ---------------------------------------------------------------- 直播

  // qn 指定清晰度，不传时使用配置
  async function live(room, qn) {
    // getInfoByRoom 对未登录请求几乎总是 -352，改用 getRoomBaseInfo；返回以真实房间号为键，短号也能查到
    const base = await bili.api("https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo?req_biz=web_room_componet&room_ids=" + room, { referer: "https://live.bilibili.com/" });
    const roomInfo = Object.values((base && base.by_room_ids) || {})[0] || {};

    const cfg = bili.config().live;
    const want = qn || cfg.quality;
    const play = await bili.api(`https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${room}`
      + `&protocol=0,1&format=0,1,2&codec=0,1&qn=${want}&platform=web&ptype=8&dolby=5&panorama=1`, { referer: "https://live.bilibili.com/" });
    if (!play) return null;
    const playurl = play.playurl_info && play.playurl_info.playurl;
    const streams = playurl && playurl.stream;
    if (play.live_status !== 1 || !streams) {
      bili.fail(`直播间 ${room} 未开播`);
      return null;
    }

    // 收集所有可用的流，rank 越小越优先：先按格式顺序，再按编码顺序
    const candidates = [];
    cfg.formats.forEach((fmtName, fi) => {
      const w = LIVE_FORMATS[fmtName];
      cfg.codecs.forEach((codecName, ci) => {
        for (const s of streams) {
          if (!w || s.protocol_name !== w[0]) continue;
          for (const f of s.format || []) {
            if (f.format_name !== w[1]) continue;
            for (const c of f.codec || []) {
              if (c.codec_name === codecName && c.url_info && c.url_info[0]) {
                candidates.push({ c, rank: fi * 100 + ci, label: `${w[0]}/${w[1]}/${codecName}` });
              }
            }
          }
        }
      });
    });
    if (!candidates.length) {
      bili.fail("没有可用的直播流");
      return null;
    }

    // 未登录时服务器无视请求的 qn，每种编码只给固定一档，accept_qn 里更高的档位拿不到，只列出实际返回的档位
    const names = {};
    for (const d of playurl.g_qn_desc || []) names[d.qn] = d.desc;
    const loggedIn = !!(await bili.uid());
    const qualities = [];
    const add = (q) => { if (q && !qualities.some((x) => x.qn === q)) qualities.push({ qn: q, name: names[q] || String(q) }); };
    for (const cand of candidates) {
      if (loggedIn) (cand.c.accept_qn || []).forEach(add);
      add(cand.c.current_qn);
    }
    qualities.sort((a, b) => b.qn - a.qn);

    // 优先选正好是目标清晰度的流，其次按格式与编码顺序
    candidates.sort((x, y) => (y.c.current_qn === want) - (x.c.current_qn === want) || x.rank - y.rank);
    // 某种格式的 CDN 整体 404 时有发生（实测 FLV 全部 404 而 HLS 正常），逐个探测，最多试 6 个地址
    let chosen = null, path = null, tries = 0;
    outer: for (const cand of candidates) {
      const urls = cand.c.url_info.map((u) => u.host + cand.c.base_url + u.extra);
      for (const u of cdnOrder(urls)) {
        if (++tries > 6) break outer;
        if (await bili.httpOk(u, "https://live.bilibili.com/")) {
          chosen = cand;
          path = u;
          break outer;
        }
        bili.warn(`直播流不可用（${cand.label}），尝试下一个: ${(u.match(/^https?:\/\/([^/]+)/) || [])[1] || u}`);
      }
    }
    if (!chosen) {
      bili.fail("所有直播流地址都无法访问");
      return null;
    }
    bili.log(`直播 ${chosen.label} qn=${chosen.c.current_qn}`);
    const roomId = String(play.room_id || room);
    return {
      type: "live", url: path, room: roomId,
      title: "【直播】" + (roomInfo.title || room), author: roomInfo.uname,
      web: "https://live.bilibili.com/" + roomId,
      qualities, qn: chosen.c.current_qn, codec: chosen.label,
    };
  }

  // ---------------------------------------------------------------- 列表

  function list(items) {
    return { type: "list", items };
  }

  // fetch(page) 返回 [条目数组, 是否还有下一页] 或 null；累计到 maxItems 条为止
  async function paged(fetch, firstPage) {
    const items = [];
    let page = firstPage || 1;
    while (items.length < limit()) {
      const r = await fetch(page);
      if (!r) break;
      const [batch, more] = r;
      for (const it of batch) if (items.length < limit()) items.push(it);
      if (!more || !batch.length) break;
      page++;
    }
    return list(items);
  }

  async function recommend() {
    const seen = new Set();
    return paged(async (page) => {
      const data = await bili.api(`https://api.bilibili.com/x/web-interface/index/top/feed/rcmd?ps=30&fresh_type=4`
        + `&feed_version=V8&fresh_idx=${page}&fresh_idx_1h=${page}&brush=${page}&homepage_ver=1`);
      if (!data) return null;
      const items = [];
      for (const v of data.item || []) {
        const owner = v.owner && v.owner.name;
        // 换一批推荐时会重复返回之前出现过的视频或直播间
        const it = v.goto === "av" && v.bvid ? videoItem(v.bvid, v.title, owner, v.duration, v.pic)
          : v.goto === "live" && v.room_info ? liveItem(v.room_info.room_id || v.id, v.title, owner, v.pic) : null;
        if (it && !seen.has(it.url)) {
          seen.add(it.url);
          items.push(it);
        }
      }
      return [items, page < 10];
    });
  }

  function archiveList(arr) {
    return (arr || []).map((v) => videoItem(v.bvid, v.title, v.owner && v.owner.name, v.duration, v.pic));
  }

  async function popular() {
    return paged(async (page) => {
      const data = await bili.api("https://api.bilibili.com/x/web-interface/popular?ps=50&pn=" + page);
      return data && [archiveList(data.list), !data.no_more];
    });
  }

  // 排行榜接口校验 Referer，不是排行榜页面时未登录请求一律返回 -352
  async function ranking(name) {
    const data = await bili.api("https://api.bilibili.com/x/web-interface/ranking/v2?type=all&rid=" + (RANK_RIDS[name] || 0),
      { referer: "https://www.bilibili.com/v/popular/rank/" + name });
    return data && list(archiveList(data.list));
  }

  async function precious() {
    const data = await bili.api("https://api.bilibili.com/x/web-interface/popular/precious?page_size=100&page=1");
    return data && list(archiveList(data.list));
  }

  async function weekly(url) {
    // 与排行榜一样校验 Referer
    const opts = { referer: "https://www.bilibili.com/v/popular/weekly" };
    let num = query(url, "num");
    if (!num) {
      const data = await bili.api("https://api.bilibili.com/x/web-interface/popular/series/list", opts);
      num = data && data.list && data.list[0] && data.list[0].number;
      if (!num) return null;
    }
    const data = await bili.api("https://api.bilibili.com/x/web-interface/popular/series/one?number=" + num, opts);
    return data && list(archiveList(data.list));
  }

  async function search(url) {
    const keyword = query(url, "keyword");
    if (!keyword) return list([]);
    const liveSearch = /search\.bilibili\.com\/live/.test(url);
    return paged(async (page) => {
      const data = await bili.api(`https://api.bilibili.com/x/web-interface/search/type?search_type=${liveSearch ? "live_room" : "video"}`
        + `&keyword=${encodeURIComponent(keyword)}&page=${page}`);
      if (!data) return null;
      const items = [];
      for (const v of data.result || []) {
        if (liveSearch) {
          if (v.live_status === 1) items.push(liveItem(v.roomid, v.title, clean(v.uname), v.user_cover || v.cover));
        } else if (v.bvid) {
          items.push(videoItem(v.bvid, v.title, v.author, v.duration, v.pic));
        }
      }
      return [items, page < (data.numPages || 1)];
    }, Number(query(url, "page")) || 1);
  }

  // UP 主投稿：空间的 arc/search 接口需要浏览器指纹，未登录基本被风控，改用播放列表（medialist）接口按游标翻页
  async function spaceVideos(mid) {
    const items = [];
    let oid = "";
    while (items.length < limit()) {
      const data = await bili.api(`https://api.bilibili.com/x/v2/medialist/resource/list?type=1&biz_id=${mid}&ps=20`
        + `&desc=true&sort_field=1&with_current=false&oid=${oid}`);
      if (!data || !data.media_list || !data.media_list.length) break;
      for (const v of data.media_list) {
        if (items.length < limit()) items.push(videoItem(v.bv_id, v.title, v.upper && v.upper.name, v.duration, v.cover));
      }
      if (!data.has_more) break;
      oid = String(data.media_list[data.media_list.length - 1].id);
    }
    return list(items);
  }

  async function collection(mid, sid) {
    return paged(async (page) => {
      const data = await bili.api(`https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${sid}`
        + `&sort_reverse=false&page_num=${page}&page_size=30`);
      if (!data) return null;
      const pg = data.page || {};
      return [(data.archives || []).map((v) => videoItem(v.bvid, v.title, null, v.duration, v.pic)),
        (pg.page_num || 0) * (pg.page_size || 0) < (pg.total || 0)];
    });
  }

  async function series(mid, sid) {
    return paged(async (page) => {
      const data = await bili.api(`https://api.bilibili.com/x/series/archives?mid=${mid}&series_id=${sid}&sort=asc&pn=${page}&ps=30`);
      if (!data) return null;
      const pg = data.page || {};
      return [(data.archives || []).map((v) => videoItem(v.bvid, v.title, null, v.duration, v.pic)),
        (pg.num || 0) * (pg.size || 0) < (pg.total || 0)];
    });
  }

  async function favlist(fid, mid, isCollect) {
    if (!fid) {
      // 没有指定收藏夹时取该用户（或已登录用户）的第一个收藏夹，即默认收藏夹
      mid = mid || (await bili.uid());
      if (!mid) {
        bili.fail("请在链接中指定 fid，或先登录");
        return null;
      }
      const data = await bili.api("https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=" + mid);
      fid = data && data.list && data.list[0] && data.list[0].id;
      if (!fid) return null;
    }
    if (isCollect) {
      const data = await bili.api("https://api.bilibili.com/x/space/fav/season/list?season_id=" + fid);
      return list(((data && data.medias) || []).map((v) => videoItem(v.bvid, v.title, v.upper && v.upper.name, v.duration, v.cover)));
    }
    return paged(async (page) => {
      const data = await bili.api(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${fid}&ps=20&pn=${page}&order=mtime&platform=web`);
      if (!data) return null;
      // type 2 为视频；attr 非 0 的是失效视频
      const items = (data.medias || []).filter((v) => v.type === 2 && v.attr === 0)
        .map((v) => videoItem(v.bvid, v.title, v.upper && v.upper.name, v.duration, v.cover));
      return [items, data.has_more];
    });
  }

  async function requireLogin() {
    if (await bili.uid()) return true;
    bili.fail("该功能需要登录 B 站，请在插件设置中配置登录方式");
    return false;
  }

  async function watchlater() {
    if (!(await requireLogin())) return null;
    const data = await bili.api("https://api.bilibili.com/x/v2/history/toview");
    return list(((data && data.list) || []).map((v) => {
      const it = videoItem(v.bvid, v.title, v.owner && v.owner.name, v.duration, v.pic);
      if (v.videos > 1 && v.page) {
        it.url += "?p=" + v.page.page;
        it.title += " | " + (v.page.part || "");
      }
      return it;
    }));
  }

  async function history() {
    if (!(await requireLogin())) return null;
    const items = [];
    let max = "0", viewAt = "0";
    while (items.length < limit()) {
      const data = await bili.api(`https://api.bilibili.com/x/web-interface/history/cursor?ps=30&max=${max}&view_at=${viewAt}`);
      if (!data || !data.list || !data.list.length) break;
      for (const v of data.list) {
        if (items.length >= limit()) break;
        const h = v.history || {};
        if (h.business === "archive") {
          const it = videoItem(h.bvid, v.title, v.author_name, v.duration, v.cover);
          if ((v.videos || 1) > 1) {
            it.url += "?p=" + (h.page || 1);
            if (v.show_title) it.title += " | " + v.show_title;
          }
          items.push(it);
        } else if (h.business === "pgc" && h.epid) {
          items.push(withCover({ url: "https://www.bilibili.com/bangumi/play/ep" + h.epid, title: v.title + " " + (v.show_title || "") }, v.cover));
        } else if (h.business === "live" && v.live_status === 1) {
          items.push(liveItem(h.oid, v.title, v.author_name, v.cover));
        }
      }
      max = String((data.cursor && data.cursor.max) || 0);
      viewAt = String((data.cursor && data.cursor.view_at) || 0);
      if (max === "0") break;
    }
    return list(items);
  }

  async function dynamic(url) {
    if (!(await requireLogin())) return null;
    const kind = query(url, "tab") === "video" ? "video" : "all";
    const items = [];
    let offset = "";
    for (let page = 1; page <= 5 && items.length < limit(); page++) {
      const data = await bili.api(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?timezone_offset=-480&type=${kind}&page=${page}&offset=${offset}`);
      if (!data) break;
      for (const d of data.items || []) {
        const modules = d.modules || {};
        const author = modules.module_author && modules.module_author.name;
        const major = modules.module_dynamic && modules.module_dynamic.major;
        if (!major || typeof major !== "object") continue;
        if (major.archive && major.archive.bvid) {
          const a = major.archive;
          items.push(videoItem(a.bvid, a.title, author, a.duration_text, a.cover));
        } else if (major.live_rcmd) {
          let info = null;
          try {
            info = JSON.parse(major.live_rcmd.content).live_play_info;
          } catch (e) {
            info = null;
          }
          if (info && info.live_status === 1) items.push(liveItem(info.room_id, info.title, author, info.cover));
        }
      }
      offset = data.offset || "";
      if (!data.has_more) break;
    }
    return list(items.slice(0, limit()));
  }

  async function followingLive() {
    if (!(await requireLogin())) return null;
    return paged(async (page) => {
      const data = await bili.api("https://api.live.bilibili.com/xlive/web-ucenter/user/following?page_size=29&page=" + page);
      if (!data) return null;
      const items = [];
      let more = page < (data.totalPage || 1);
      for (const r of data.list || []) {
        // 列表按开播状态排序，遇到第一个未开播的即可停止
        if (r.live_status !== 1) {
          more = false;
          break;
        }
        // 关注列表里的直播间封面经常为空，退而用主播头像
        items.push(liveItem(r.roomid, r.title, r.uname, r.room_cover || r.face));
      }
      return [items, more];
    });
  }

  async function liveArea(parentId, areaId) {
    return paged(async (page) => {
      const data = await bili.api(`https://api.live.bilibili.com/room/v3/area/getRoomList?parent_area_id=${parentId}&area_id=${areaId}`
        + `&page=${page}&page_size=30&sort_type=online`);
      if (!data) return null;
      return [(data.list || []).map((r) => liveItem(r.roomid, r.title, r.uname, r.cover || r.user_cover)), page * 30 < (data.count || 0)];
    });
  }

  // ---------------------------------------------------------------- 入口

  async function route(url, opts) {
    opts = opts || {};
    let m = str(url).match(/^https?:\/\/([^/?#]+)([^#]*)/i);
    if (!m) return null;
    let host = m[1].toLowerCase().replace(/:\d+$/, "");
    if (host === "b23.tv" || host.endsWith(".b23.tv")) {
      const real = await bili.resolveRedirect(url);
      if (!real || /^https?:\/\/(www\.)?b23\.tv/i.test(real)) return null;
      return route(real, opts);
    }
    const path = m[2] || "";
    if (host === "m.bilibili.com") host = "www.bilibili.com";

    if (host === "live.bilibili.com") {
      const parentId = query(path, "parentAreaId");
      if (parentId) return liveArea(parentId, query(path, "areaId") || "0");
      m = path.match(/^\/(?:h5\/|blanc\/)?(\d+)/);
      return m ? live(m[1], opts.liveQn) : null;
    }
    if (host === "link.bilibili.com") return followingLive();
    if (host === "t.bilibili.com") return dynamic(path);
    if (host === "search.bilibili.com") return search(url);

    if (host === "space.bilibili.com") {
      m = path.match(/^\/(\d+)/);
      if (!m) return null;
      const mid = m[1];
      if (path.includes("/favlist")) return favlist(query(path, "fid"), mid, query(path, "ftype") === "collect");
      const sid = query(path, "sid");
      if (path.includes("collectiondetail") && sid) return collection(mid, sid);
      if (path.includes("seriesdetail") && sid) return series(mid, sid);
      const lists = path.match(/\/lists\/(\d+)/);
      if (lists) return query(path, "type") === "series" ? series(mid, lists[1]) : collection(mid, lists[1]);
      return spaceVideos(mid);
    }

    if (host !== "www.bilibili.com" && host !== "bilibili.com") return null;

    m = path.match(/\/video\/(BV\w+|av\d+)/i);
    if (m) return video(url, /^bv/i.test(m[1]) ? "BV" + m[1].slice(2) : m[1].toLowerCase());
    m = path.match(/\/bangumi\/play\/ep(\d+)/);
    if (m) return episode(url, m[1]);
    m = path.match(/\/bangumi\/play\/ss(\d+)/);
    if (m) return seasonList("season_id=" + m[1]);
    m = path.match(/\/bangumi\/media\/md(\d+)/);
    if (m) {
      const sid = await mdToSs(m[1]);
      return sid ? seasonList("season_id=" + sid) : null;
    }

    m = path.match(/\/medialist\/detail\/ml(\d+)/) || path.match(/\/list\/ml(\d+)/);
    if (m) return favlist(m[1]);
    if (/^\/(list\/)?watchlater/.test(path)) return watchlater();
    if (/^\/(account\/)?history/.test(path)) return history();

    m = path.match(/^\/v\/popular\/rank\/(\w+)/);
    if (m) return ranking(m[1]);
    if (path.startsWith("/v/popular/history")) return precious();
    if (path.startsWith("/v/popular/weekly")) return weekly(path);
    if (path.startsWith("/v/popular")) return popular();

    if (path === "" || path === "/" || path.startsWith("/?") || path.startsWith("/index.html")) return recommend();
    return null;
  }

  return { route, resolveStream, live };
}

module.exports = { createParser, cdnOrder, videoTracks, audioTracks, defaultVideoIndex, mpvCodec };
