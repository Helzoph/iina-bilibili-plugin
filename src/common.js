// 公共模块：配置、HTTP（调用系统 curl）、Cookie 与 B 站接口封装。
// 所有和运行环境有关的操作都通过 env 完成，IINA 里由 index.js 提供，测试里由 node 提供：
//   env.exec(file, args) -> Promise<{ status, stdout, stderr }>
//   env.pref(key) / env.setPref(key, value)
//   env.read(path) / env.write(path, content) / env.resolve(path)，路径可用 @data/、@tmp/ 前缀
//   env.log(msg) / env.warn(msg) / env.error(msg)
"use strict";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const REFERER = "https://www.bilibili.com/";
const LIVE_REFERER = "https://live.bilibili.com/";
const CURL = "/usr/bin/curl";

// 与 Info.json 的 preferenceDefaults 保持一致，测试环境没有 IINA 提供的默认值时使用
const DEFAULTS = {
  cookie_source: "firefox",
  cookie: "",
  max_quality: "127",
  video_codec: "hevc",
  hires_audio: true,
  live_quality: "10000",
  live_codec: "avc",
  live_format: "flv",
  danmaku_enable: true,
  danmaku_show: true,
  danmaku_font: "",
  danmaku_font_size: 48,
  danmaku_opacity: 0.8,
  danmaku_display_area: 0.8,
  danmaku_scroll_time: 10,
  danmaku_fixed_time: 5,
  danmaku_bold: true,
  subtitle_enable: true,
  max_items: 100,
  debug: false,
};

// Firefox 的 cookies.sqlite 运行时被锁定且最新数据可能还在 -wal 里，复制到临时目录再读。
// $1 为本次读取专用的临时目录（多个播放器窗口各有一份插件实例，共用目录会让 sqlite 报 database is locked），读完删除；
// $2 为用户主目录（IINA 运行外部命令时只设置 LC_ALL，没有 $HOME）；输出每行：配置目录名 \t 名称 \t 值 \t originAttributes \t lastAccessed \t expiry
const FIREFOX_SCRIPT = `
PATH=/usr/bin:/bin
tmp="$1"
mkdir -p "$tmp"
for db in "$2/Library/Application Support/Firefox/Profiles/"*/cookies.sqlite; do
  [ -f "$db" ] || continue
  profile=$(basename "$(dirname "$db")")
  cp "$db" "$tmp/ff.sqlite" || continue
  if [ -f "$db-wal" ]; then cp "$db-wal" "$tmp/ff.sqlite-wal"; else : > "$tmp/ff.sqlite-wal"; fi
  /usr/bin/sqlite3 -tabs "$tmp/ff.sqlite" "select '$profile', name, value, originAttributes, lastAccessed, expiry from moz_cookies where host in ('.bilibili.com', 'bilibili.com', 'www.bilibili.com')"
done
status=$?
rm -f "$tmp/ff.sqlite" "$tmp/ff.sqlite-wal" "$tmp/ff.sqlite-shm"
rmdir "$tmp" 2>/dev/null
exit $status
`;

function str(v) {
  return v === undefined || v === null ? "" : String(v);
}

function decode(s) {
  try {
    return decodeURIComponent(str(s).replace(/\+/g, " "));
  } catch (e) {
    return str(s);
  }
}

// 链接中的查询参数（不含 # 之后的部分）
function query(url, key) {
  const m = str(url).match(new RegExp("[?&]" + key + "=([^&#]*)"));
  return m ? decode(m[1]) : null;
}

function https(url) {
  if (typeof url !== "string" || url === "") return null;
  if (url.startsWith("//")) return "https:" + url;
  return url.replace(/^http:\/\//, "https://");
}

// 接受秒数或 "1:02:03" 形式的时长
function seconds(v) {
  if (typeof v === "number") return v > 0 ? v : null;
  let total = 0;
  for (const part of str(v).match(/\d+/g) || []) total = total * 60 + Number(part);
  return total > 0 ? total : null;
}

// 搜索结果标题里带有 <em class="keyword"> 高亮标签和 HTML 实体
function clean(s) {
  return str(s).replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function isBilibiliHost(host) {
  host = str(host).toLowerCase();
  return host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv";
}

function isBilibiliUrl(url) {
  const m = str(url).match(/^https?:\/\/([^/?#:]+)/i);
  return !!m && isBilibiliHost(m[1]);
}

// 解析 Firefox 导出的行，挑出最近使用过且已登录（有 SESSDATA）的那组 Cookie。
// 同一配置的不同“身份容器”（originAttributes）各算一组，组内同名 Cookie 取最近使用的
function pickFirefoxCookie(output, nowMs) {
  const groups = {};
  for (const line of str(output).split("\n")) {
    const f = line.split("\t");
    if (f.length < 6 || !f[1]) continue;
    let expiry = Number(f[5]);
    // 新版 Firefox 以毫秒存储过期时间，旧版为秒
    if (expiry < 1e11) expiry *= 1000;
    if (expiry && expiry < nowMs) continue;
    const key = f[0] + "|" + f[3];
    const g = groups[key] || (groups[key] = { cookies: {}, login: 0, isDefault: f[3] === "" });
    const access = Number(f[4]) || 0;
    const old = g.cookies[f[1]];
    if (!old || access > old.access) g.cookies[f[1]] = { value: f[2], access };
    if (f[1] === "SESSDATA") g.login = Math.max(g.login, access);
  }
  let best = null;
  for (const g of Object.values(groups)) {
    if (!g.login) continue;
    if (!best || g.login > best.login || (g.login === best.login && g.isDefault && !best.isDefault)) best = g;
  }
  if (!best) return "";
  return Object.keys(best.cookies).map((name) => name + "=" + best.cookies[name].value).join("; ");
}

function createBili(env) {
  let cachedUserCookie = null;
  let userCookieTime = 0;
  let buvid = null;
  let headerFileContent = null;

  function log(msg) {
    if (pref("debug")) env.log("[bilibili] " + msg);
  }

  function pref(key) {
    const v = env.pref(key);
    return v === undefined || v === null || v === "" && DEFAULTS[key] !== "" ? DEFAULTS[key] : v;
  }

  function num(key) {
    const v = Number(pref(key));
    return Number.isFinite(v) ? v : DEFAULTS[key];
  }

  // 把首选项放到最前，其余保持默认顺序
  function primary(list, first) {
    return list.includes(first) ? [first].concat(list.filter((x) => x !== first)) : list.slice();
  }

  function config() {
    return {
      video: {
        maxQuality: num("max_quality"),
        codecs: primary(["hevc", "avc", "av1"], pref("video_codec")),
        hiresAudio: !!pref("hires_audio"),
      },
      live: {
        quality: num("live_quality"),
        codecs: primary(["avc", "hevc"], pref("live_codec")),
        formats: primary(["flv", "ts", "fmp4"], pref("live_format")),
      },
      danmaku: {
        enable: !!pref("danmaku_enable"),
        show: !!pref("danmaku_show"),
        font: str(pref("danmaku_font")),
        fontSize: num("danmaku_font_size"),
        opacity: Math.min(1, Math.max(0, num("danmaku_opacity"))),
        displayArea: Math.min(1, Math.max(0.1, num("danmaku_display_area"))),
        scrollTime: Math.max(1, num("danmaku_scroll_time")),
        fixedTime: Math.max(1, num("danmaku_fixed_time")),
        bold: !!pref("danmaku_bold"),
      },
      subtitle: { enable: !!pref("subtitle_enable") },
      maxItems: Math.max(1, num("max_items")),
    };
  }

  // ---------------------------------------------------------------- HTTP

  async function curl(args) {
    let r;
    try {
      r = await env.exec(CURL, args);
    } catch (e) {
      env.error("[bilibili] 无法运行 curl: " + e);
      return null;
    }
    if (!r || r.status !== 0) {
      env.warn("[bilibili] curl 失败 status=" + (r && r.status) + " " + str(r && r.stderr).trim());
      return null;
    }
    return r.stdout;
  }

  // Cookie 写进文件再用 -H @文件 传给 curl，避免出现在进程参数里
  function cookieHeaderArgs(cookie) {
    if (!cookie) return [];
    const content = "Cookie: " + cookie + "\n";
    if (content !== headerFileContent) {
      env.write("@tmp/cookie-header.txt", content);
      headerFileContent = content;
    }
    return ["-H", "@" + env.resolve("@tmp/cookie-header.txt")];
  }

  async function httpGet(url, opts) {
    opts = opts || {};
    log("GET " + url);
    const args = ["-sSL", "--compressed", "--max-time", "15", "-A", UA, "-H", "Referer: " + (opts.referer || REFERER)];
    const cookie = opts.cookie === false ? "" : await cookieString();
    return curl(args.concat(cookieHeaderArgs(cookie), [url]));
  }

  // 用 HEAD 请求探测媒体地址是否可用。直播 FLV/TS 服务器无视 Range 持续推流，GET 会一直等到超时，所以用 HEAD。
  // 只有明确返回 4xx/5xx 才判为不可用：实测失效的 CDN 都是直接 404，而 2 秒内没响应的多是仍在正常推流的服务器
  async function httpOk(url, referer) {
    const r = await env.exec(CURL, ["-s", "-I", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2",
      "-A", UA, "-H", "Referer: " + (referer || REFERER), url]).catch(() => null);
    const code = Number(r && r.stdout) || 0;
    return code < 400;
  }

  // b23.tv 短链需要跟随跳转拿到真实地址
  async function resolveRedirect(url) {
    const out = await curl(["-sSL", "-o", "/dev/null", "-w", "%{url_effective}", "--max-time", "10", "-A", UA, url]);
    return out ? out.trim() : null;
  }

  // ---------------------------------------------------------------- Cookie

  async function firefoxCookie() {
    const tmp = env.resolve("@tmp/") + "firefox-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    // 插件目录位于 ~/Library/Application Support/com.colliderli.iina/ 下，由此得到主目录
    const home = (env.resolve("@data/").match(/^(.*?)\/Library\//) || [])[1];
    if (!home) return "";
    const r = await env.exec("/bin/sh", ["-c", FIREFOX_SCRIPT, "sh", tmp, home]).catch(() => null);
    if (!r) return "";
    if (r.status !== 0 && r.stderr) env.warn("[bilibili] 读取 Firefox Cookie 出错: " + str(r.stderr).trim());
    return pickFirefoxCookie(r.stdout, Date.now());
  }

  // 用户登录 Cookie（来自 Firefox 或手动填写），Firefox 的结果缓存 10 分钟。
  // 读取脚本每次都写同一个临时数据库副本，并发读取会互相覆盖而读到空 Cookie（启动时登录检查与链接解析同时发生），
  // 所以同一时间只读一次：并发调用共用进行中的读取，refresh 等它结束后再读
  let readingCookie = null;
  async function userCookie(refresh) {
    const source = pref("cookie_source");
    if (source === "manual") return str(pref("cookie")).trim().replace(/[;\s]+$/, "");
    if (source !== "firefox") return "";
    if (readingCookie) {
      const pending = readingCookie;
      await pending;
      if (!refresh) return cachedUserCookie;
      // 多个 refresh 同时等待时只由第一个发起新的读取
      if (readingCookie && readingCookie !== pending) return readingCookie;
    }
    if (refresh || cachedUserCookie === null || Date.now() - userCookieTime > 600000) {
      readingCookie = firefoxCookie().then((cookie) => {
        cachedUserCookie = cookie;
        userCookieTime = Date.now();
        log(cookie ? "已从 Firefox 读取登录 Cookie" : "Firefox 中没有找到 B 站登录 Cookie");
        return cookie;
      }).finally(() => { readingCookie = null; });
      return readingCookie;
    }
    return cachedUserCookie;
  }

  // 未登录时排行榜、每周必看等接口会因为缺少 buvid 指纹被风控（-352），向官方接口领一份并缓存
  async function buvidCookie(refresh) {
    if (buvid && !refresh) return buvid;
    const path = "@data/buvid.txt";
    if (!refresh) {
      const cached = env.read(path);
      if (cached && cached.startsWith("buvid3=")) return (buvid = cached);
    }
    let data = null;
    try {
      data = JSON.parse(await httpGet("https://api.bilibili.com/x/frontend/finger/spi", { cookie: false })).data;
    } catch (e) {
      data = null;
    }
    if (!data || !data.b_3) return "";
    buvid = "buvid3=" + data.b_3 + "; buvid4=" + encodeURIComponent(data.b_4 || "");
    env.write(path, buvid);
    return buvid;
  }

  async function cookieString(refresh) {
    const user = await userCookie(false);
    if (/(^|;\s*)buvid3=/.test(user)) return user;
    const b = await buvidCookie(refresh);
    return [user, b].filter(Boolean).join("; ");
  }

  async function uid() {
    const m = (await userCookie(false)).match(/(?:^|;\s*)DedeUserID=(\d+)/);
    return m ? m[1] : null;
  }

  // ---------------------------------------------------------------- 接口

  const state = { lastError: "" };

  // 请求 B 站 JSON 接口，code 非 0 时记录错误并返回 null；普通接口数据在 data，番剧接口在 result
  async function api(url, opts, attempt) {
    opts = opts || {};
    attempt = attempt || 0;
    const text = await httpGet(url, opts);
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      obj = null;
    }
    if (!obj || typeof obj !== "object") {
      fail("接口返回的不是 JSON: " + url);
      return null;
    }
    // -352 风控：未登录时同一个 buvid 连续请求每周必看等接口很快会被拦，新领的 buvid 通常能成功一次。
    // 先最多换两次新 buvid 重试，仍失败再完全不带 Cookie 试一次
    if (obj.code === -352 && attempt < 3 && opts.cookie !== false && !(await uid())) {
      log("触发风控 -352，重试");
      if (attempt < 2) {
        await cookieString(true);
        return api(url, opts, attempt + 1);
      }
      return api(url, Object.assign({}, opts, { cookie: false }), 3);
    }
    if (obj.code !== 0) {
      fail(`接口错误 code=${obj.code} message=${obj.message} url=${url}`, obj.message);
      return null;
    }
    // 风控拦截时 code 仍为 0，data 里只有一个验证码凭据
    if (obj.data && typeof obj.data === "object" && obj.data.v_voucher) {
      fail("请求被 B 站风控拦截，请稍后再试或登录: " + url, "请求被 B 站风控拦截");
      return null;
    }
    return obj.data !== undefined && obj.data !== null ? obj.data : obj.result !== undefined && obj.result !== null ? obj.result : obj;
  }

  function fail(msg, short) {
    env.error("[bilibili] " + msg);
    state.lastError = short || msg;
  }

  return {
    config, pref, log, fail, state,
    httpGet, httpOk, resolveRedirect, api,
    userCookie, cookieString, uid,
    warn: (msg) => env.warn("[bilibili] " + msg),
  };
}

module.exports = {
  UA, REFERER, LIVE_REFERER, DEFAULTS,
  createBili, pickFirefoxCookie,
  str, decode, query, https, seconds, clean, isBilibiliUrl,
};
