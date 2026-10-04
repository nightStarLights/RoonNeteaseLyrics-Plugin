<h1 align="center">RoonNeteaseLyrics</h1>

<p align="center">通过Roon API获取当前播放音乐，一个基于Electron的歌词显示窗口</p>

```
┌──────────────┐   node-roon-api   ┌────────────────────────────────────┐
│  Roon Core   │ ────────────────► │  extension/  Roon 扩展              │
│  播放区状态   │   zones/now_playing│  ├ 官方直连 / 内置库(可选) ────────┼──► music.163.com
└──────────────┘                   │  ├ 数据源路由 / 搜索匹配 / LRC 解析 │
                                   │  └ 进度推算 + WebSocket 广播        │
                                   └────────────────┬───────────────────┘
                                                    │ ws://127.0.0.1:8687
                                                    ▼
                                   ┌────────────────────────────────────┐
                                   │  desktop/  桌面悬浮歌词窗口         │
                                   │  逐行滚动 + 当前行高亮 + 翻译 + 封面 │
                                   └────────────────────────────────────┘
```

## 首次使用

1. 打开 **Roon → 设置 → 扩展**，找到 **「网易云歌词 (NetEase Lyrics)」**，点 **启用**
2. **随便放一首歌**，歌词窗口里就会开始滚动

配对信息会写进 `extension/config.json` 的 `roonstate`，之后自动重连，不用再点一次。

> 首次使用可能存在歌词提前/滞后 —— 这是**音频设备的延迟**，你需要进入**设置**调整全局偏移。

## 时间轴（歌词对不上怎么办）

歌词的滚动位置跟着 Roon 上报的播放进度走，但声音从 Roon Core 传到你的耳朵，
中间要经过网络、USB/同轴、DAC、蓝牙或无线链路、功放和音箱的内部缓冲——
**这段延迟完全取决于你的设备**，几毫秒到几秒都有可能。

## 快捷键

窗口聚焦时直接按键即可（不依赖全局快捷键）：

| 按键 | 功能 |
| --- | --- |
| `T` | 切换歌词显示：原词+翻译 → 原词+注音 → 仅原词 |
| `P` | 纯享模式开关 |
| `[` / `]` | 歌词时间轴 −0.5s / +0.5s（按曲目记忆） |
| `\` | 当前曲目偏移归零 |
| `A` | 对齐到 Roon（主动拉取最新播放进度） |
| `L` / `H` | 锁定（鼠标穿透）/ 显示隐藏 |
| `S` / `F` / `R` | 设置面板 / 搜索面板 / 重新匹配歌词 |
| `↑` / `↓` | 字号增减 |
| `Esc` / `F12` | 关闭面板 / 开发者工具 |

## 歌词数据源

三种数据源，默认自动选择：

| 数据源 | 取值 | 说明 | 依赖 |
| --- | --- | --- | --- |
| 官方直连 | `direct` | 直接请求网易云官方公开接口，参考 [netease-music-plugin](https://github.com/XBisATrouble/netease-music-plugin) 的 direct 模式 | **无**，开箱即用 |
| 内置库（可选） | `lib` | 在扩展进程内直接调用 `NeteaseCloudMusicApi`，接口最全、最稳 | **需要你自己装**，见下 |
| 外部服务 | `ncm` | 连你自己另外部署的 NeteaseCloudMusicApi 服务 | 需要自己启动服务 |

`lyricSource: "auto"`（默认）= **内置库可用就用它，否则自动走官方直连**。
只有当你在设置里显式选择「本机服务」时才会去连独立服务。

**不需要部署任何服务**：默认的官方直连不依赖任何依赖包，装完就能用。

### 为什么内置库是可选的

上游仓库 [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)
已经 **Public archive（删库归档）**。为了不再向下游分发这个依赖，本项目
**没有把它写进 `package.json`**；但完整的接入代码保留着，你自己装了就能用：

```bash
cd extension && npm install NeteaseCloudMusicApi
```

装好重启即可 —— `auto` 模式会自动优先用它。**不装也完全能用**，
官方直连不依赖任何依赖包，一样出歌词（只是接口覆盖面窄一些）。

> ⚠️ 已经装好内置库的话，**别在 `extension` 目录直接跑 `npm install`**：
> 它没写在 `package.json` 里，会被当成多余依赖删掉。真跑了就补回来：
>
> ```bash
> cd extension && npm install --no-save NeteaseCloudMusicApi
> ```

## 配置文件

### extension/config.json

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `lyricSource` | `"auto"` | `auto` 内置库优先+回退直连 / `lib` 只用内置库 / `direct` 只用官方直连 / `ncm` 只用外部服务 |
| `ncmApi` | `http://127.0.0.1:14300` | **仅 `lyricSource: "ncm"` 时使用**，桌面端设置面板也能改 |
| `cookie` | `""` | 可选，`MUSIC_U=...`，提高冷门曲目命中率 |
| `zone` | `""` | 监听的播放区名称。**留空 = 自动跟随正在播放的区**（推荐）。填了就只认这一个设备，可以用桌面端设置面板里的「监听 Roon 设备」下拉框直接改 |
| `minMatchScore` | `55` | 匹配分数阈值 |
| `filterCredits` | `true` | 过滤「作词 : xxx」等制作信息行 |
| `translation` | `true` | 合并翻译歌词 |
| `romaji` | `true` | 合并注音歌词（网易云 `romalrc`，日文歌是罗马音） |
| `lyricOffsetMs` | `0` | **全局**偏移，正数 = 歌词提前显示，单位毫秒 |
| `port` / `host` | `8687` / `127.0.0.1` | 扩展对外服务地址 |
| `ncmTimeoutMs` | `8000` | 网易云接口超时 |
| `ncmHealthIntervalMs` | `30000` | 数据源探测间隔 |
| `progressIntervalMs` | `400` | 进度广播间隔 |
| `logLevel` | `info` | `error` / `warn` / `info` / `debug` |

`roonstate` 字段由 Roon 配对时自动写入，不要手改。这个文件在 `.gitignore` 里
（存着配对令牌），分享给别人或提交到公开仓库前记得确认它没被带上——
删掉也没关系，扩展会按默认值重新创建。

### 匹配打分

```
标题相似度 × 60  +  艺术家相似度 × 25  +  专辑相似度 × 10
+  时长奖励(最高 +15)  +  艺术家不符扣分(0 ~ -15)  +  版本差异扣分(0 / -18 / -25)
伴奏版（Instrumental / Off Vocal / 纯音乐）在查询没有同样标记时直接淘汰
```

艺术家维度会把**标题里的 feat. 演唱者也算进来**（两侧都算）：
例如 Roon 曲目 `Not Falling` / 艺术家 `棗いつき`，网易云上只有
`Not Falling (feat. 棗いつき)` 且其 artists 字段只有主艺人 `Imy` 时，
仍然能从标题里取到 `棗いつき` 完成匹配（110 分），而不是误配到同名的无关版本。

匹配器还会主动排除**伴奏 / Off Vocal / 纯音乐**版本，并对 Live / Remaster 等版本差异扣分，
减少「匹配到别的版本」导致的整体偏移。

## 接口

扩展默认监听 `http://127.0.0.1:8687`：

| 接口 | 说明 |
| --- | --- |
| `GET /` | 调试页面 |
| `GET /health` | 健康检查（含三个数据源的可用性） |
| `GET /api/diagnostics` | **时间轴诊断**（原始 seek / 推算进度 / 当前歌词行） |
| `GET /api/diagnostics/history` | **位置变化历史**（每次重新锚定的原因与数值） |
| `GET /api/state` | 完整快照 |
| `GET /api/search?keywords=` | 搜索候选 |
| `GET /api/cover?key=&size=` | 代理 Roon 封面图 |
| `POST /api/refresh` `/api/select` `/api/config` `/api/offset` | 重新匹配 / 指定歌曲 / 改配置 / 调偏移 |
| `WS /ws` | 实时推送 |

WebSocket 消息：`hello` / `snapshot`（含 `settings`）、`player`、`lyrics`、`progress`、`roon`、`ncm`、`offset`、`realign`、`config`、`searchResult`。
客户端可发：`select`、`search`、`refresh`、`config`、`offset`、`ping`。

## 桌面窗口

| 操作 | 说明 |
| --- | --- |
| 拖动窗口 | 按住窗口拖动；拖右下角缩放 |
| 悬停窗口 | 右上角工具条：**译/音** / **纯** / 🔍 搜索 / ⟳ 重新匹配 / ⚙ 设置 / **−** 缩小字号 / **＋** 放大字号 / 🔓 锁定 / ✕ 隐藏 |
| 锁定后 | 解锁与字号按钮移到**窗口正上方居中**（`− 🔒 ＋`），鼠标移上去即可点击，不用再跑到右上角 |
| 托盘图标 | 左键切换显示，右键打开菜单（字号、歌词显示、纯享模式、各项开关、退出） |

设置面板里可以改：**监听 Roon 设备**、**歌词数据源**、外部服务地址、
**歌词颜色**（全局 / 原歌词 / 翻译·注音分开设置）、歌词显示模式、字号、不透明度、显示项、
**当前曲目时间轴偏移**、**全局时间轴偏移**、**全局快捷键**，以及查看数据源状态。

### 纯享模式

工具条的 `纯` 按钮（或托盘菜单 / `P` 键）切换。开启后窗口**完全透明**：
没有底板、没有封面、没有曲目信息与进度条，只剩歌词。

- **鼠标移到窗口内的任何位置**（歌词区、顶部曲目信息、底部进度条、工具条那一排）都会还原出完整界面，移开又变回纯歌词；
- **锁定时**鼠标移上去不会还原背景，只在正上方露出 `− 🔒 ＋` 浮动条，方便随时解锁或调字号。

> 窗口拖动是用 JS 实现的，没有用 `-webkit-app-region: drag`。
> 原因是 Windows 下拖拽区域不派发鼠标事件、`:hover` 也不触发，
> 用它的话整个窗口只有少数标了 `no-drag` 的小按钮能响应悬停，纯享模式的还原范围会小得没法用。

## 歌词显示

### 译 / 音

工具条上的 `译/音` 按钮，每点一次在三种模式间循环，按钮上点亮的那一半表示当前模式：

| 模式 | 按钮外观 | 显示内容 |
| --- | --- | --- |
| **原词 + 翻译**（默认） | `译` 白，`音` 灰 | 原文 + 中文翻译 |
| **原词 + 注音** | `译` 灰，`音` 白 | 原文 + 日文罗马音（来自网易云的 `romalrc`） |
| **仅原词** | 两个字都灰 | 只有原文 |

翻译与注音不会同时显示（同时显示会让每行占三行高度、非常拥挤）。
两种内容都来自网易云，非日文歌曲一般没有注音——此时按钮提示会标注「当前曲目没有对应内容」。

> 注：注音是整行的罗马音（`shi zu mu yo u ni to ke te yu ku yo u ni` 这种），
> 不是逐字假名标注——LRC 只提供每行的起始时间，逐字/逐词的对应关系无法从数据里还原。

### 过长的歌词会自动缩小

一句歌词太长时会**逐行自动缩小字号**，保证折行后完整落在歌词区内——
歌词区上下各有 14% 的渐变遮罩，句尾太长会被裁掉，所以这里按
「折行后的总高度 ≤ 歌词区 70%（再扣除当前行 1.06 倍放大）」来算每行该用多大字号。
只有长句会被缩，短句保持你设定的字号；缩放下限 0.3 倍。

另外**切换字号后当前行会保持居中**（不会跳到别处、要等下一句才复位）。

### 歌词颜色

设置面板的「歌词颜色」里三个取色器：**全局**（改一次同时设置下面两种）、**原歌词**、**翻译 / 注音**。
窗口透明或纯享模式下同样生效，改完立即应用并记住。

### 关于行内高亮

LRC 只提供每行歌词的起始时间，行内每个字/词的起止时间无法从数据里推出来，
做插值填充只是「看起来精确、实际靠猜」。所以桌面端只按行高亮——
当前行整体变白发光，其余行按距离渐隐。

## 安装 / 部署

### 前置条件

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 18 | 扩展与桌面端都基于 Node |
| Roon Core | 与本机处于同一局域网 |
| Windows 10+ / macOS | 桌面窗口使用透明无边框窗口，Windows 上体验最佳 |

### 安装

```bash
cd extension && npm install      # 只装 Roon API 与 ws，不含歌词库
cd ../desktop && npm install     # 会下载约 100MB 的 Electron 二进制
```

> 桌面端自带 `.npmrc`，使用 npmmirror 镜像加速 Electron 下载。海外网络可删除本文件。

### 启动与停止

| 操作 | 命令 |
| --- | --- |
| 启动全部 | 双击 `start-all.bat` |
| 停止全部 | 双击 `stop-all.bat` |
| 查看状态 | `node launcher.js status` |

需要看日志时，改用前台运行：

```bat
cd extension && node .            :: 前台运行扩展，直接看输出
cd desktop && npm start           :: 前台运行桌面窗口
```

### 打包成 exe（免装 Node）

**双击 `build-exe.bat`**，或在 `desktop` 目录执行 `npm run build`。

产物在 `dist/RoonNeteaseLyrics-win32-x64/`，双击其中的 **`RoonNeteaseLyrics.exe`** 即可运行——
**它会同时把 Roon 扩展和歌词窗口一起启动**，目标机器上不需要安装 Node，也不需要任何外部服务。

打包方式说明：

- 扩展（`extension/` 整包）作为额外资源放进 `resources/extension`；
- 主进程用 `ELECTRON_RUN_AS_NODE=1` 复用 Electron 自带的 Node 去跑它
  （扩展是纯 JS、没有原生模块，所以这么做没问题）；
- 托盘菜单里多了 **「歌词扩展：运行中 / 已停止」**，可以随时开关；扩展异常退出时会弹提示说明原因
  （例如「端口 8687 已被占用」）。

首次运行会把随包携带的 `config.json` 复制到 `%APPDATA%\RoonNeteaseLyrics\extension\`，
配置、歌词缓存、按曲目偏移都写在这里。所以：

- **程序目录可以随意移动或整体删除重建，配对信息不会丢**；
- 反过来，如果要重新配对（或把 exe 发给别人），把上面那个目录删掉即可；
- 随包的 `extension/config.json` 里带着你自己的配对信息，**分享打包产物前记得清掉它**；
- 打包会把本地 `extension/node_modules` 一起带进去：**如果你装了可选的内置库，
  发布前先删掉 `extension/node_modules/NeteaseCloudMusicApi`**，避免连带分发；
- 应用名（也就是这个目录名）固定为纯 ASCII 的 `RoonNeteaseLyrics`，
  中文路径在别的机器上容易被某些工具搞出编码问题。旧版本用的 `Roon 网易云歌词` 目录
  会在首次运行时自动把设置搬过来，搬完可以自己删掉（里面剩余的只是浏览器缓存）。

## 调试

```bash
cd extension

# 查询某首歌的匹配与歌词结果（默认 auto）
node tools/lookup.js "Lost colors" "konoco" 232

# 指定数据源
node tools/lookup.js "海阔天空" "Beyond" 326 --source=lib
node tools/lookup.js "海阔天空" "Beyond" 326 --source=direct

# 完整 JSON（含候选列表与评分）
node tools/lookup.js "晴天" "周杰伦" --json

# 不连接 Roon，用内置歌单模拟播放
node index.js --demo

# 演示模式默认每首 45 秒，可以调短来验证连续切歌
DEMO_SECONDS=6 node index.js --demo

# 播放进度推算的回归自测（不联网、不连 Roon）
node tools/test-position.js

# 歌词解析 / 匹配的回归自测
node tools/test-lyrics.js
```

### 时间轴出问题时

打开这两个地址，位置为什么跳、被哪一类修正拉走，一目了然：

```
http://127.0.0.1:8687/api/diagnostics            当前进度、锚点、应高亮的歌词行
http://127.0.0.1:8687/api/diagnostics/history    每一次位置变化的时间与原因
```

`history` 会记录每次位置变化的类型（`track` / `state` / `forward` / `seek-soft` / `seek-hard` /
`realign` / `stall` / `unfreeze`）、Roon 报的值与本地推算值。
把 `logLevel` 改成 `debug` 后，`logs\extension.log` 还会打印每次校准的偏差。
卡顿相关的数值（`reportIntervalMs` / `reportedSeekAgeMs` / `stalled` /
`stallThresholdMs` / `stallAllowanceSec`）也能在 `/api/diagnostics` 里看到。

## 常见错误

**Roon 里看不到扩展**
确认扩展与 Roon Core 在同一局域网，扩展用 UDP 组播搜索 Core；跨网段/虚拟网卡会搜不到。
检查 `logs\extension.log` 是否有「已配对 Roon Core」。

**显示的是别的播放区的歌曲 / 换了设备就不显示**
打开设置面板的 **「监听 Roon 设备」**——一个**可以输入的下拉框**：

- **留空 = 自动跟随正在播放的设备**（推荐，换设备不用改）
- 点右侧下拉箭头可以直接从 **Roon 当前检测到的设备**里选，也可以自己打字
- 填了 = 只监听它。名称不用写全、包含即可匹配、不区分大小写

输入框下面还会实时列出现在 Roon 里有哪些播放区（含播放/暂停状态）、正在监听哪一台。
改完按回车或点别处生效，不用重启。

**提示「未安装可选的「内置库」」**
这是正常提示，不是错误——内置库本来就是可选项，此时会自动走官方直连。
看到它之后歌词仍能正常显示就不必理会。

**还需要装 NeteaseCloudMusicApi 吗？**
不需要部署服务，也不需要装包——默认走官方直连，开箱即用。
只有想让歌词覆盖面更全时，才 `cd extension && npm install NeteaseCloudMusicApi` 启用可选的内置库
（上游仓库已归档，所以它没有写进 `package.json`）。
另外想用**独立服务**的话，把 `lyricSource` 改成 `"ncm"` 并自己起一个服务。

**歌词一直不出现**
打开 `http://127.0.0.1:8687` 看状态。若三个数据源都不可用，多半是网络问题；
若只是匹配分低，点 🔍 手动搜索指定。

**内置库加载失败**
先确认它真的装过：`cd extension && npm install --no-save NeteaseCloudMusicApi`。
装不上也没关系，把 `lyricSource` 设为 `direct` 直连模式照样能出歌词。

**歌词和声音差一截 / 越听越偏**
音频设备的延迟，见 [时间轴](#时间轴歌词对不上怎么办)，按 `[` `]` 或 `A` 校准。

**启动时提示端口 8687 被占用**
已有一个扩展实例在跑。双击 `stop-all.bat` 清干净再启动，或用 `node launcher.js status` 确认。

**某个全局快捷键不生效**
被其它软件占用了。设置面板底部会列出每个快捷键的可用状态；
用窗口内按键，或在设置文件里改键/留空。

## 许可

MIT。Roon API 遵循 [RoonLabs/node-roon-api](https://github.com/RoonLabs/node-roon-api) 的 Apache-2.0。

歌词取自网易云音乐的公开接口，本项目只做请求与解析，不包含其任何代码。
直连模式的接口用法参考 [XBisATrouble/netease-music-plugin](https://github.com/XBisATrouble/netease-music-plugin)。

可选的内置库模式兼容 [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)（上游已归档），
但它**不是本项目的依赖、也不随本项目分发**——需要的话请自行安装并遵守其许可。
