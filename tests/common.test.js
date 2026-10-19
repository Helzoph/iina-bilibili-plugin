"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../src/common");
const { mockEnv } = require("./harness");

const NOW = 1_800_000_000_000;
const FUTURE_MS = NOW + 86400_000;
const FUTURE_S = Math.floor(FUTURE_MS / 1000);
const row = (profile, name, value, origin, access, expiry) => [profile, name, value, origin, access, expiry].join("\t");

test("str 把 null/undefined 转成空串", () => {
  assert.equal(c.str(null), "");
  assert.equal(c.str(undefined), "");
  assert.equal(c.str(0), "0");
});

test("decode 解码 + 与百分号编码，非法编码原样返回", () => {
  assert.equal(c.decode("a+b%E4%B8%AD"), "a b中");
  assert.equal(c.decode("%E4%"), "%E4%");
});

test("query 读取参数且忽略 # 之后的部分", () => {
  assert.equal(c.query("https://x/?a=1&keyword=%E5%A5%BD#keyword=no", "keyword"), "好");
  assert.equal(c.query("https://x/?a=1", "b"), null);
  assert.equal(c.query("", "a"), null);
});

test("https 补全协议并把 http 升级为 https", () => {
  assert.equal(c.https("//i0.hdslb.com/a.jpg"), "https://i0.hdslb.com/a.jpg");
  assert.equal(c.https("http://a.com/x"), "https://a.com/x");
  assert.equal(c.https(""), null);
  assert.equal(c.https(undefined), null);
});

test("seconds 解析数字与 h:m:s 时长", () => {
  assert.equal(c.seconds(90), 90);
  assert.equal(c.seconds(0), null);
  assert.equal(c.seconds("1:02:03"), 3723);
  assert.equal(c.seconds("05:30"), 330);
  assert.equal(c.seconds("120"), 120);
  assert.equal(c.seconds(""), null);
  assert.equal(c.seconds(null), null);
});

test("clean 去掉搜索高亮标签并还原实体", () => {
  assert.equal(c.clean('<em class="keyword">原神</em> &amp; &lt;b&gt; &quot;x&quot; &#39;y&#39;'), "原神 & <b> \"x\" 'y'");
});

test("isBilibiliUrl 只接受 B 站域名与 b23.tv", () => {
  assert.equal(c.isBilibiliUrl("https://www.bilibili.com/video/BV1"), true);
  assert.equal(c.isBilibiliUrl("https://live.bilibili.com/1"), true);
  assert.equal(c.isBilibiliUrl("http://bilibili.com"), true);
  assert.equal(c.isBilibiliUrl("https://b23.tv/abc"), true);
  assert.equal(c.isBilibiliUrl("https://www.bilibili.com.evil.com/"), false);
  assert.equal(c.isBilibiliUrl("https://notbilibili.com/"), false);
  assert.equal(c.isBilibiliUrl("edl://x"), false);
  assert.equal(c.isBilibiliUrl("/Users/me/a.mp4"), false);
  assert.equal(c.isBilibiliUrl(undefined), false);
});

test("pickFirefoxCookie 在没有登录 Cookie 时返回空串", () => {
  assert.equal(c.pickFirefoxCookie("", NOW), "");
  assert.equal(c.pickFirefoxCookie(row("p", "buvid3", "b", "", 5, FUTURE_MS), NOW), "");
  assert.equal(c.pickFirefoxCookie("garbage\nline", NOW), "");
});

test("pickFirefoxCookie 选出最近使用的登录容器，只返回该容器的 Cookie", () => {
  const out = [
    row("p1", "SESSDATA", "old", "^userContextId=1", 100, FUTURE_MS),
    row("p1", "DedeUserID", "111", "^userContextId=1", 100, FUTURE_MS),
    row("p1", "SESSDATA", "new", "", 200, FUTURE_MS),
    row("p1", "DedeUserID", "222", "", 200, FUTURE_MS),
    row("p2", "buvid3", "x", "", 999, FUTURE_MS),
  ].join("\n");
  assert.equal(c.pickFirefoxCookie(out, NOW), "SESSDATA=new; DedeUserID=222");
});

test("pickFirefoxCookie 使用时间相同时优先默认容器", () => {
  const out = [
    row("p", "SESSDATA", "container", "^userContextId=2", 100, FUTURE_MS),
    row("p", "SESSDATA", "default", "", 100, FUTURE_MS),
  ].join("\n");
  assert.equal(c.pickFirefoxCookie(out, NOW), "SESSDATA=default");
});

test("pickFirefoxCookie 跳过已过期的 Cookie，过期时间兼容秒与毫秒", () => {
  const out = [
    row("p", "SESSDATA", "expired", "", 300, NOW - 1000),
    row("p", "SESSDATA", "valid_s", "", 200, FUTURE_S),
    row("p", "bili_jct", "old_s", "", 100, Math.floor((NOW - 1000) / 1000)),
    row("p", "sid", "session", "", 100, 0),
  ].join("\n");
  assert.equal(c.pickFirefoxCookie(out, NOW), "SESSDATA=valid_s; sid=session");
});

test("pickFirefoxCookie 同名 Cookie 取最近使用的值", () => {
  const out = [
    row("p", "SESSDATA", "a", "", 100, FUTURE_MS),
    row("p", "SESSDATA", "b", "", 300, FUTURE_MS),
    row("p", "SESSDATA", "c", "", 200, FUTURE_MS),
  ].join("\n");
  assert.equal(c.pickFirefoxCookie(out, NOW), "SESSDATA=b");
});

// ---------------------------------------------------------------- createBili

test("config 使用默认值，并把字符串形式的清晰度转为数字", () => {
  const bili = c.createBili(mockEnv({}, []));
  const cfg = bili.config();
  assert.equal(cfg.video.maxQuality, 127);
  assert.deepEqual(cfg.video.codecs, ["hevc", "avc", "av1"]);
  assert.equal(cfg.live.quality, 10000);
  assert.deepEqual(cfg.live.formats, ["flv", "ts", "fmp4"]);
  assert.equal(cfg.danmaku.fontSize, 48);
  assert.equal(cfg.maxItems, 100);
});

test("config 把首选编码排在最前，并限制数值范围", () => {
  const bili = c.createBili(mockEnv({
    max_quality: "80", video_codec: "av1", live_codec: "hevc", live_format: "ts",
    danmaku_opacity: 3, danmaku_display_area: 0, danmaku_scroll_time: 0, max_items: 0, danmaku_font_size: "abc",
  }, []));
  const cfg = bili.config();
  assert.equal(cfg.video.maxQuality, 80);
  assert.deepEqual(cfg.video.codecs, ["av1", "hevc", "avc"]);
  assert.deepEqual(cfg.live.codecs, ["hevc", "avc"]);
  assert.deepEqual(cfg.live.formats, ["ts", "flv", "fmp4"]);
  assert.equal(cfg.danmaku.opacity, 1);
  assert.equal(cfg.danmaku.displayArea, 0.1);
  assert.equal(cfg.danmaku.scrollTime, 1);
  assert.equal(cfg.danmaku.fontSize, 48);
  assert.equal(cfg.maxItems, 1);
});

test("config 去掉弹幕字体名里会破坏 ASS 样式行的逗号与换行", () => {
  const bili = c.createBili(mockEnv({ danmaku_font: " Songti SC,Bold\n" }, []));
  assert.equal(bili.config().danmaku.font, "Songti SCBold");
});

test("config 中未知的编码偏好保持默认顺序", () => {
  const bili = c.createBili(mockEnv({ video_codec: "vp9" }, []));
  assert.deepEqual(bili.config().video.codecs, ["hevc", "avc", "av1"]);
});

test("pref 对空字符串回退默认值，但保留默认就是空串的项", () => {
  const bili = c.createBili(mockEnv({ video_codec: "", cookie: "" }, []));
  assert.equal(bili.pref("video_codec"), "hevc");
  assert.equal(bili.pref("cookie"), "");
});

test("api 返回 data，番剧接口返回 result", async () => {
  const env = mockEnv({ cookie_source: "none" }, [
    [/spi/, { code: 0, data: { b_3: "B3", b_4: "B4" } }],
    [/\/data/, { code: 0, data: { x: 1 } }],
    [/\/pgc/, { code: 0, result: { y: 2 } }],
    [/\/plain/, { code: 0 }],
  ]);
  const bili = c.createBili(env);
  assert.deepEqual(await bili.api("https://api.bilibili.com/data"), { x: 1 });
  assert.deepEqual(await bili.api("https://api.bilibili.com/pgc"), { y: 2 });
  assert.deepEqual(await bili.api("https://api.bilibili.com/plain"), { code: 0 });
});

test("api 在 code 非 0 时返回 null 并记录错误信息", async () => {
  const env = mockEnv({ cookie_source: "none" }, [
    [/spi/, { code: 0, data: { b_3: "B3" } }],
    [/err/, { code: -404, message: "啥都木有" }],
  ]);
  const bili = c.createBili(env);
  assert.equal(await bili.api("https://api.bilibili.com/err"), null);
  assert.equal(bili.state.lastError, "啥都木有");
  assert.ok(env.logs.some(([lvl, m]) => lvl === "error" && m.includes("-404")));
});

test("api 对非 JSON 或 curl 失败返回 null", async () => {
  const env = mockEnv({ cookie_source: "none" }, [
    [/spi/, null],
    [/html/, "<html>"],
    [/down/, null],
  ]);
  const bili = c.createBili(env);
  assert.equal(await bili.api("https://api.bilibili.com/html"), null);
  assert.match(bili.state.lastError, /不是 JSON/);
  assert.equal(await bili.api("https://api.bilibili.com/down"), null);
  assert.ok(env.logs.some(([lvl, m]) => lvl === "warn" && m.includes("curl 失败")));
});

test("api 识别 code 为 0 的验证码拦截", async () => {
  const env = mockEnv({ cookie_source: "none" }, [
    [/spi/, { code: 0, data: { b_3: "B3" } }],
    [/x/, { code: 0, data: { v_voucher: "voucher_xxx" } }],
  ]);
  const bili = c.createBili(env);
  assert.equal(await bili.api("https://api.bilibili.com/x"), null);
  assert.equal(bili.state.lastError, "请求被 B 站风控拦截");
});

test("api 未登录遇到 -352 时换新 buvid 重试", async () => {
  let spi = 0;
  const env = mockEnv({ cookie_source: "none" }, [
    [/spi/, () => ({ code: 0, data: { b_3: "B3_" + ++spi } })],
    [/weekly/, [{ code: -352 }, { code: 0, data: { ok: 1 } }]],
  ]);
  const bili = c.createBili(env);
  assert.deepEqual(await bili.api("https://api.bilibili.com/weekly"), { ok: 1 });
  const calls = env.requests.filter((r) => /weekly/.test(r.url));
  assert.equal(calls.length, 2);
  assert.match(calls[0].cookie, /buvid3=B3_1/);
  assert.match(calls[1].cookie, /buvid3=B3_2/);
});

test("api 两次换 buvid 仍被风控时最后不带 Cookie 再试一次", async () => {
  let spi = 0;
  const env = mockEnv({ cookie_source: "none" }, [
    [/spi/, () => ({ code: 0, data: { b_3: "B3_" + ++spi } })],
    [/weekly/, (url, req) => (req.cookie ? { code: -352 } : { code: 0, data: { ok: 2 } })],
  ]);
  const bili = c.createBili(env);
  assert.deepEqual(await bili.api("https://api.bilibili.com/weekly"), { ok: 2 });
  const calls = env.requests.filter((r) => /weekly/.test(r.url));
  assert.equal(calls.length, 4);
  assert.equal(calls[3].cookie, null);
});

test("api 重试全部失败后报告 -352", async () => {
  const env = mockEnv({ cookie_source: "none" }, [
    [/spi/, { code: 0, data: { b_3: "B3" } }],
    [/weekly/, { code: -352, message: "-352" }],
  ]);
  const bili = c.createBili(env);
  assert.equal(await bili.api("https://api.bilibili.com/weekly"), null);
  assert.equal(env.requests.filter((r) => /weekly/.test(r.url)).length, 4);
  assert.equal(bili.state.lastError, "-352");
});

test("api 已登录时遇到 -352 不重试", async () => {
  const env = mockEnv({ cookie_source: "manual", cookie: "SESSDATA=s; DedeUserID=42; buvid3=b" }, [
    [/weekly/, { code: -352, message: "-352" }],
  ]);
  const bili = c.createBili(env);
  assert.equal(await bili.api("https://api.bilibili.com/weekly"), null);
  assert.equal(env.requests.length, 1);
});

test("httpGet 通过文件传递 Cookie，Cookie 不出现在命令参数中", async () => {
  const env = mockEnv({ cookie_source: "manual", cookie: "SESSDATA=secret; DedeUserID=1;  " }, [
    [/spi/, { code: 0, data: { b_3: "B3", b_4: "a/b" } }],
    [/x/, "ok"],
  ]);
  const bili = c.createBili(env);
  assert.equal(await bili.httpGet("https://api.bilibili.com/x", { referer: "https://r/" }), "ok");
  const req = env.requests.find((r) => /\/x$/.test(r.url));
  assert.equal(req.referer, "https://r/");
  assert.equal(req.cookie, "SESSDATA=secret; DedeUserID=1; buvid3=B3; buvid4=a%2Fb");
  assert.ok(!req.args.some((a) => a.includes("secret")));
});

test("httpGet 指定 cookie:false 时不带 Cookie", async () => {
  const env = mockEnv({ cookie_source: "manual", cookie: "SESSDATA=s" }, [[/x/, "ok"]]);
  const bili = c.createBili(env);
  await bili.httpGet("https://api.bilibili.com/x", { cookie: false });
  assert.equal(env.requests[0].cookie, null);
  assert.equal(env.requests[0].referer, c.REFERER);
});

test("cookieString 在用户 Cookie 已含 buvid3 时不再领取", async () => {
  const env = mockEnv({ cookie_source: "manual", cookie: "buvid3=mine; SESSDATA=s" }, []);
  const bili = c.createBili(env);
  assert.equal(await bili.cookieString(), "buvid3=mine; SESSDATA=s");
  assert.equal(env.requests.length, 0);
});

test("buvid 写入数据目录，下次直接读取缓存", async () => {
  const env = mockEnv({ cookie_source: "none" }, [[/spi/, { code: 0, data: { b_3: "B3", b_4: "B4" } }]]);
  await c.createBili(env).cookieString();
  assert.equal(env.read("@data/buvid.txt"), "buvid3=B3; buvid4=B4");
  const bili2 = c.createBili(env);
  assert.equal(await bili2.cookieString(), "buvid3=B3; buvid4=B4");
  assert.equal(env.requests.filter((r) => /spi/.test(r.url)).length, 1);
});

test("cookieString 在领取 buvid 失败时返回空串", async () => {
  const env = mockEnv({ cookie_source: "none" }, [[/spi/, "not json"]]);
  assert.equal(await c.createBili(env).cookieString(), "");
});

test("userCookie 从 Firefox 读取，并把主目录与临时目录传给脚本", async () => {
  let args = null;
  const env = mockEnv({ cookie_source: "firefox" }, [], {
    home: "/Users/tester",
    firefox: (a) => {
      args = a;
      return row("p", "SESSDATA", "s", "", 1, 0) + "\n" + row("p", "DedeUserID", "7", "", 1, 0);
    },
  });
  const bili = c.createBili(env);
  assert.equal(await bili.userCookie(), "SESSDATA=s; DedeUserID=7");
  assert.equal(await bili.uid(), "7");
  assert.equal(args[0], "-c");
  assert.ok(args[3].startsWith(env.resolve("@tmp/") + "firefox-"));
  assert.equal(args[4], "/Users/tester");
});

test("userCookie 缓存 Firefox 结果，refresh 时重新读取", async () => {
  let n = 0;
  const env = mockEnv({ cookie_source: "firefox" }, [], {
    home: "/Users/t",
    firefox: () => row("p", "SESSDATA", "v" + ++n, "", 1, 0),
  });
  const bili = c.createBili(env);
  assert.equal(await bili.userCookie(), "SESSDATA=v1");
  assert.equal(await bili.userCookie(), "SESSDATA=v1");
  assert.equal(await bili.userCookie(true), "SESSDATA=v2");
});

// IINA 启动时登录状态检查与链接解析同时进行；两次读取共用同一个临时数据库副本，并发时会互相覆盖导致读到空 Cookie
test("userCookie 并发调用时只读取一次 Firefox，所有调用拿到同一结果", async () => {
  let n = 0;
  const env = mockEnv({ cookie_source: "firefox" }, [], {
    home: "/Users/t",
    firefox: () => row("p", "SESSDATA", "v" + ++n, "", 1, 0),
  });
  const bili = c.createBili(env);
  const got = await Promise.all([bili.userCookie(false), bili.uid(), bili.userCookie(false)]);
  assert.equal(n, 1);
  assert.deepEqual(got, ["SESSDATA=v1", null, "SESSDATA=v1"]);
});

test("userCookie 在读取进行中收到 refresh 时等它结束后再读一次", async () => {
  let n = 0;
  const env = mockEnv({ cookie_source: "firefox" }, [], {
    home: "/Users/t",
    firefox: () => row("p", "SESSDATA", "v" + ++n, "", 1, 0),
  });
  const bili = c.createBili(env);
  const [a, b] = await Promise.all([bili.userCookie(false), bili.userCookie(true)]);
  assert.deepEqual([a, b, n], ["SESSDATA=v1", "SESSDATA=v2", 2]);
});

test("userCookie 在 Firefox 脚本出错或无法推导主目录时返回空串", async () => {
  const broken = mockEnv({ cookie_source: "firefox" }, [], { home: "/Users/t", firefox: null });
  assert.equal(await c.createBili(broken).userCookie(), "");
  assert.ok(broken.logs.some(([lvl, m]) => lvl === "warn" && m.includes("Firefox")));
  // 默认的临时目录路径里没有 /Library/
  const noHome = mockEnv({ cookie_source: "firefox" }, [], { firefox: () => { throw new Error("不应被调用"); } });
  assert.equal(await c.createBili(noHome).userCookie(), "");
});

test("userCookie 在关闭登录时返回空串，uid 为 null", async () => {
  const bili = c.createBili(mockEnv({ cookie_source: "none", cookie: "DedeUserID=1" }, []));
  assert.equal(await bili.userCookie(), "");
  assert.equal(await bili.uid(), null);
});

test("httpOk 仅在 4xx/5xx 时判为不可用", async () => {
  const env = mockEnv({}, [[/ok/, "200"], [/gone/, "404"], [/slow/, null]]);
  const bili = c.createBili(env);
  assert.equal(await bili.httpOk("https://a/ok"), true);
  assert.equal(await bili.httpOk("https://a/gone"), false);
  assert.equal(await bili.httpOk("https://a/slow"), true);
  assert.ok(env.requests.every((r) => r.head));
});

test("resolveRedirect 返回跳转后的地址，失败时返回 null", async () => {
  const env = mockEnv({}, [[/b23\.tv\/ok/, "https://www.bilibili.com/video/BV1\n"], [/b23\.tv\/bad/, null]]);
  const bili = c.createBili(env);
  assert.equal(await bili.resolveRedirect("https://b23.tv/ok"), "https://www.bilibili.com/video/BV1");
  assert.equal(await bili.resolveRedirect("https://b23.tv/bad"), null);
});

test("exec 抛出异常时 httpGet 返回 null 并记录错误", async () => {
  const env = mockEnv({ cookie_source: "none" }, []);
  env.exec = async () => { throw new Error("no permission"); };
  const bili = c.createBili(env);
  assert.equal(await bili.httpGet("https://a/x", { cookie: false }), null);
  assert.ok(env.logs.some(([lvl, m]) => lvl === "error" && m.includes("no permission")));
});

test("log 仅在开启调试时输出", async () => {
  const quiet = mockEnv({ debug: false }, []);
  c.createBili(quiet).log("hi");
  assert.equal(quiet.logs.length, 0);
  const loud = mockEnv({ debug: true }, []);
  c.createBili(loud).log("hi");
  assert.deepEqual(loud.logs, [["log", "[bilibili] hi"]]);
});
