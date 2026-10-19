# IINA Bilibili 插件

让 macOS 播放器 [IINA](https://iina.io) 直接播放 B 站：视频、番剧、直播都能用原画/4K 播放，弹幕作为可开关的字幕显示，还可以在侧边栏里浏览推荐、关注的直播和动态，点一下就播。体验仿照 Windows 上的 [BilibiliPotPlayer](https://github.com/chen310/BilibiliPotPlayer)。

**为什么不用 IINA 自带的 Online Media（yt-dlp）？** 它未登录时最高 1080P、没有弹幕、直播清晰度低，也不能在播放中切换清晰度。本插件读取 Firefox 里已登录的 B 站账号，能拿到账号可用的最高画质（4K、Hi-Res 音频、直播原画），所有清晰度都出现在 IINA 原生的“视频轨道”菜单里随时切换。

## 快速开始

需要 IINA 1.4 或更新版本、Node.js（构建用）和 [just](https://github.com/casey/just)（`brew install just`）。

```sh
just install    # 构建、跑测试，并以开发模式链接到 IINA
```

然后 **⌘Q 退出 IINA 再重新打开**，在“设置 > 插件”里能看到 Bilibili。之后：

- ⌘⇧O 粘贴任意 B 站链接（视频、番剧、直播间、UP 主空间、收藏夹……）即可播放；
- 或者打开播放窗口的“插件”侧边栏 → Bilibili → 浏览，挑一个视频或直播；
- 想看 4K / 直播原画，先在 Firefox 里登录 B 站（默认自动读取，见下文“登录”）。

## 功能

- **直接打开链接**：在 IINA 里“打开网址”（⌘⇧O）或把链接拖进窗口即可，不依赖 yt-dlp。
- **清晰度切换**：每个视频的所有清晰度都出现在“视频 > 视频轨道”里，名称如“超清 4K · HEVC”。切换时从当前进度无缝继续，只有正在看的那一档消耗流量。选过的清晰度会记为下次的默认上限。
- **音质**：Hi-Res 无损、杜比全景声、192K 等出现在“音频 > 音频轨道”里。
- **弹幕**：作为名为“弹幕”的字幕轨，可以在“字幕”菜单或“插件 > Bilibili > 显示弹幕”（⌘D）里开关，开关状态会被记住。正在显示 CC 字幕时，弹幕作为第二字幕同时显示。
- **CC / AI 字幕**：自动加载为普通字幕轨。
- **直播**：直接打开直播间链接即播放登录账号能拿到的最高清晰度（默认原画），也可以在“插件 > Bilibili > 直播清晰度”里切换。
- **列表**：UP 主投稿、合集、收藏夹、番剧、多 P 视频、搜索结果、排行榜、热门、每周必看、首页推荐等会展开成 IINA 播放列表，轮到播放时再解析。
- **登录**：自动读取 Firefox 里已登录的 B 站账号，登录后可以看 4K、1080P 高码率和大会员内容。
- **侧边栏**：播放窗口的“插件”侧边栏里有 Bilibili 页，分两栏：
  - **正在播放**：显示标题、UP 主和登录状态，可以直接点选清晰度、音质、编码偏好，开关弹幕，刷新播放地址。
  - **浏览**：像 PotPlayer 插件那样在侧边栏里挑内容——推荐、关注直播、动态、热门、稍后再看、历史，以及视频/直播搜索。列表带封面，点一下就在当前窗口播放。关注直播、动态、稍后再看、历史需要登录。切换分类时 5 分钟内沿用上次的结果，点“刷新”或再点一次当前分类重新获取。

  也可以用“插件 > Bilibili > 显示侧边栏”打开。

## 安装

所有命令都在本目录下运行，`just` 可列出全部命令：

| 命令 | 作用 |
| --- | --- |
| `just install` | 推荐。构建并测试后，在 IINA 插件目录里建立指向本目录的开发链接。以后改了代码只需 `just build` 再重启 IINA |
| `just uninstall` | 移除开发链接（只删链接，不动本目录） |
| `just pack` | 生成 `build/bilibili-<版本>.iinaplgz`，只含运行所需文件，可以拷给别的电脑双击安装 |
| `just install-pack` | 打包后交给 IINA 安装（与开发链接二选一，已有开发链接时会拒绝执行） |
| `just test` / `just coverage` | 运行离线测试 / 输出覆盖率 |

安装或卸载后都要 **⌘Q 退出 IINA 再重新打开**。不要用“插件 > 重新加载所有插件”，IINA 1.5.0 在这时可能崩溃。

插件目录默认是 `~/Library/Application Support/com.colliderli.iina/plugins`，可以用环境变量 `IINA_PLUGINS_DIR` 改到别处。

### 登录

默认自动读取 Firefox 里已登录的 B 站账号，不需要任何设置。用其他浏览器的话，在“设置 > 插件 > Bilibili > 偏好设置”里把登录方式改为“手动填写 Cookie”。

插件通过系统自带的 `/usr/bin/curl` 发请求，读取 Firefox Cookie 时还会调用 `/bin/sh` 和 `/usr/bin/sqlite3`，因此在 Info.json 里申请了 `file-system`（运行外部程序）和 `network-request` 权限。

Cookie 只保存在本机：插件把 Firefox 的 `cookies.sqlite` 复制到 IINA 临时目录下每次读取专用的子目录，读完即删除；请求时写入临时文件传给 curl，不会出现在命令行参数和日志中。同一窗口里同时发生的多次读取会合并成一次，避免 sqlite 报 “database is locked” 后以未登录身份请求（这曾导致直播只能拿到低清晰度）。

## 设置

“设置 > 插件 > Bilibili > 偏好设置”：

| 设置 | 说明 |
| --- | --- |
| 登录 | Firefox（默认）/ 手动填写 Cookie / 不登录。修改后点“插件 > Bilibili > 重新读取登录信息”生效 |
| 默认清晰度上限 | 默认“最高”。菜单里选择的清晰度会自动写回这里 |
| 视频编码偏好 | HEVC（默认）/ AVC / AV1。AV1 需要 M3 及以上芯片才能硬解 |
| 直播 | 默认清晰度、优先格式（FLV / HLS）、优先编码 |
| 弹幕 | 是否加载、默认是否显示、字体、字号、不透明度、显示区域、停留时间 |
| 列表最多展开 | 默认 100 条 |
| 调试日志 | 在“窗口 > 日志”里查看请求与解析过程 |

## 支持的链接

| 类型 | 示例 |
| --- | --- |
| 视频 | `https://www.bilibili.com/video/BV1xx411c7mD`、`av170001`、`?p=2`、`?t=90`、`b23.tv` 短链、`m.bilibili.com` |
| 番剧 / 电影 | `/bangumi/play/ep…`（单集）、`/bangumi/play/ss…`、`/bangumi/media/md…`（整季） |
| 直播 | `https://live.bilibili.com/房间号`、直播分区页 |
| UP 主 | `https://space.bilibili.com/UID`（投稿）、合集、视频列表、收藏夹 |
| 收藏夹 | `space.bilibili.com/UID/favlist?fid=…`、`/medialist/detail/ml…` |
| 搜索 | `https://search.bilibili.com/all?keyword=…`、`search.bilibili.com/live?keyword=…` |
| 热门 | `/v/popular/all`、`/v/popular/rank/<分区>`、`/v/popular/weekly`、`/v/popular/history`（入站必刷） |
| 首页 | `https://www.bilibili.com/`（推荐视频与直播） |
| 需要登录 | 稍后再看、历史记录、动态（`t.bilibili.com`）、关注的直播（`link.bilibili.com`） |

## 与 Online Media（yt-dlp）插件共存

IINA 自带的 Online Media 插件也能解析 B 站链接，但未登录时最高 1080P，且没有弹幕。本插件在 mpv 的 `on_load` 阶段以优先级 5 先接管 B 站链接；解析失败时不修改地址，Online Media 仍有机会接手。两个插件可以同时启用，不需要额外设置。

## 已知限制

- 高级弹幕、代码弹幕不显示；弹幕过密时为避免重叠会丢弃部分弹幕。
- 未登录时，排行榜、每周必看等接口偶尔被 B 站风控（-352）。插件会自动换新的 buvid 重试，仍失败时稍后再打开即可。登录后基本不会遇到。
- 直播没有弹幕。
- 播放地址约两小时后过期，暂停太久后无法继续时用“插件 > Bilibili > 刷新播放地址”。
- 付费内容需要账号本身有权限，未登录或无权限时只能看试看片段。

## 开发

`dist/` 和 `build/` 是生成物，不进版本库；克隆后运行 `just install` 或 `just build` 即可生成。

```
src/
  index.js     IINA 入口：注册钩子、事件与菜单
  common.js    配置、curl 封装、Firefox Cookie、B 站接口重试
  parser.js    链接分派与各类接口解析
  player.js    加载逻辑、菜单、侧边栏状态与操作、弹幕开关、清晰度记忆
  sidebar.js   侧边栏网页的加载与消息桥接
  browse.js    侧边栏“浏览”：按分类取列表（复用 parser.route）并打开所选条目
  media.js     EDL、m3u、SRT 生成
  danmaku.js   XML 弹幕转 ASS
sidebar/       侧边栏网页（index.html，无依赖）
build.js       把 src/ 打包成 dist/index.js（IINA 的 require 不缓存模块，打包更稳妥；不转译 async）
tests/         node:test 测试，网络请求全部离线模拟
```

```sh
just test        # 运行测试（等同 node build.js && node --test 'tests/*.test.js'）
just coverage    # 覆盖率
```

修改 `src/` 后需要重新运行 `just build`，然后重启 IINA。

IINA 1.5.0 的几个限制，修改入口时要注意：

- 插件脚本在播放器初始化过程中执行，此时调用 `menu.forceUpdate()` 会让 IINA 崩溃，菜单要等 `iina.window-loaded` 之后再刷新。
- `sidebar.loadFile` 会清空 `sidebar.onMessage` 注册的监听，监听必须在它之后注册。`sidebar.postMessage` 发送的字符串会被原样拼进网页里的模板字符串，所以状态先用 `encodeURIComponent` 编码。
- 不要用“插件 > 重新加载所有插件”，IINA 1.5.0 在重新发送 `iina.window-loaded` 时可能在 `sidebar.loadFile` 处崩溃。改完代码用 ⌘Q 退出后重开。
