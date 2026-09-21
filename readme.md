# koishi-plugin-waygame

[![npm](https://img.shields.io/npm/v/koishi-plugin-waygame?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-waygame)
[![downloads](https://img.shields.io/npm/dm/koishi-plugin-waygame?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-waygame)

把 [Koishi](https://koishi.chat) 机器人接到 **WayGame 文字游戏核心**：玩家在群里打字，核心跑完游戏逻辑，插件把回复发回群里。
插件本身**不含任何游戏业务**（注册、地图、背包、战斗、任务、商店全在核心里），**WayGame 那边一行代码都不用改**。

## 一、先下载游戏本体

| 包 | 大小 | 下载 | 什么时候需要 |
| --- | --- | --- | --- |
| **核心包** | 29 MB | **[Core_._20260921-1842.zip](https://github.com/Juenia/KoishiPlugin-WayGame/releases/download/WayGameCore/Core_._20260921-1842.zip)** | **必装**（核心 + 编辑器 + 游戏数据 + 教程文档） |
| **渲染包** | 139 MB | **[Render_._20260921-1842.zip](https://github.com/Juenia/KoishiPlugin-WayGame/releases/download/WayGameCore/Render_._20260921-1842.zip)** | 想要图片消息（角色卡 / 地图 / 背包出图）才装 |

历史版本与后续更新：<https://github.com/Juenia/KoishiPlugin-WayGame/releases>

1. 解压核心包到任意目录（路径别带中文和空格），双击 **启动核心.bat**（需要 Node.js 18+）
2. 想改数据就开 **编辑器\\WayGameEditor.exe**，改完在编辑器左下角重启核心
3. 想要图片消息：把渲染包解压到**核心包根目录**，会合并出 `node_modules\\electron`

> 只装核心包也能玩：文本 / Markdown 消息完全正常，图片消息会自动降级成文本，不报错。
> 渲染端口 = 编辑器「基础设置 → 渲染端口」（默认 3212）；同机跑多个核心时第二个必须换端口，
> 否则会连上第一个的渲染进程、报 unauthorized 并静默降级。

## 二、再装本插件

```sh
# 插件市场里搜 waygame 直接装，或者：
npm i koishi-plugin-waygame
```

然后在 `koishi.yml` 里启用（控制台「插件配置」里点一下也行）：

```yaml
plugins:
  waygame: {}
```

**核心地址不用手填**：核心启动时会把真实地址写到 `%LOCALAPPDATA%\\WayGame\\server-url.txt`，
插件读它即可；核心换端口后最多 10 秒自动跟上。文件在 = 核心活着，文件不在 = 核心没跑。
只有核心跑在别的机器上，才需要填 `core.url`。

## 三、验证通了

1. 浏览器打开 `http://127.0.0.1:<核心端口>/api/status`，应返回 `{"ok":true,...}`
2. 控制台「插件配置 → adapter」里确认适配器在线（QQ 官方机器人只推 @机器人 的消息，群里要 `@机器人 注册 昵称 男`）
3. 群里发 `注册 昵称 男`，应收到角色卡
4. 还没有？打开插件配置页的「调试」开关，看日志里的 `waygame` 行

## 四、这个插件做了什么

| 能力 | 说明 |
| --- | --- |
| 被动消息 | 群聊 / 私聊消息 → `POST /api/bee/message` → 按核心返回的 `type` 发 text / markdown / image |
| 静默未知 | 核心返回 `unknown=true` 时**一个字都不发**，机器人不会在群里乱插话 |
| 主动推送 | 拉取模式：定时 `POST /api/push/pull` 取件 → 发送 → `POST /api/push/ack` 回执；**一个机器人都没有时干脆不取件**（适配器没连是暂时状态，取回来只会把消息从队列里烧掉） |
| 端口自动发现 | 读 `%LOCALAPPDATA%\\WayGame\\server-url.txt`，核心换端口不用改配置 |
| 图片三选一 | 本地文件 `file://` → HTTP 地址 → base64，任一成功即止；全失败回退成可读文本 |
| 长文切分 | 超长回复按换行切成多条发，不会被平台截断丢内容 |
| 诊断指令 | `waygame.status`（权限 3）：核心地址 / 在线情况 / 推送队列 |

## 五、配置要点

全部配置项在控制台里都有中文说明，几个关键的：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `core.url` | 空 | **留空即可**，自动读端口发现文件 |
| `core.playerIdScope` | `user` | `user` = 群聊私聊共用一个角色；`scoped` = 每个群一个独立角色 |
| `message.prefix` | 空 | 空 = 每条消息都交给核心判断；填了则只有带前缀的消息才进游戏 |
| `message.unknownPolicy` | `silent` | 契约默认全静默；想让新玩家看到「请先注册」就改成 `unregistered` |
| `image.mode` | `auto` | 图片下发方式，`auto` = 本地文件 → URL → base64 |
| `push.autoSwitchToPull` | 开 | 启动时把核心推送模式切成 `pull`，核心自带工人让路，避免一条推送被投两遍 |
| `push.broadcastTarget` | 空 | 核心的 `broadcast` 类推送 `target_id` 是 null、插件无处可发；填上群号才会真的发出去 |
| `push.retryOnFailure` | 关 | **不建议开**：只有确认没发出去才该让核心重发，否则群里会重复刷屏 |

## 六、对着源码核过的几处契约细节

写这个插件时把 WayGame 的 `server.js` / `core/GameSystem.js` 一起读了，有几处和《插件接口接入文档》字面不一致，记下来免得后人再踩：

1. **`playerId` 字段核心不读。** `server.js` 的 `/api/bee/message` 里写死了 `const playerId = userId`
   （注释：「铁律：玩家 ID 直接使用插件端传来的 userId，不加任何前缀」）。所以文档 §5 说的
   「传 `bee_<群ID>_<用户ID>` 实现群聊/私聊隔离」**不会生效** —— 本插件的 `playerIdScope: scoped`
   是改成**改写 userId** 来实现同样效果的。
2. **拉取到的推送内容是数据库原文。** 文档 §9.1 提醒「换行被转义成 `\\n`，发之前要还原」，
   那只对 `POST /api/push/pull { format: 'text' }` 的 TSV 输出成立（`server.js` 的 `pushLine()`）；
   走 JSON 返回的 `content` 是原文，**不要**再去还原，否则会把正常的反斜杠 n 也换掉。
3. **`unknown` 的判定包含「请先注册」。** `server.js` 用 `/^未知指令|玩家.*未注册|请先注册/i` 算 unknown，
   所以新玩家问任何事都会被静默 —— 想让「先注册」提示发出去，把 `message.unknownPolicy` 改成 `unregistered`。
4. **两种推送模式不能共存。** pull 模式下新入队的消息 `plugin_url` 会被写成 `'pull'`，核心自带的推送工人会跳过；
   本插件拉取时**不带 plugin 过滤**，因为 pull 模式下插件就是唯一的投递者。
5. **图片降级要认 `type`。** 出图失败时核心会把 `type` 从 `image` 降回 `markdown`/`text` 并带 `imageError`，
   此时 `content` 是文本 —— **先看 type 再决定怎么发**。

## 七、自测

```sh
git clone https://github.com/Juenia/KoishiPlugin-WayGame
cd KoishiPlugin-WayGame
npm i
npm test        # 32 项端到端，不需要装游戏本体
```

`test/mock-core.ts` 是按《插件接口接入文档》实现端点的**假核心**，配合 Koishi 官方 `@koishijs/plugin-mock`
造出真实的 Session（群聊 / 私聊都有），所以「玩家打字 → 插件 → 核心 → 回复」整条链路都是真跑的，只是核心换成了假的。

覆盖：文本 / markdown / 图片 / 空图回退 / 长文切分 / 静默未知 / 未注册放行 / 群白名单 / 前缀 / 每群独立角色 /
核心离线 / 核心 500 / 消息切分 / 推送拉取回执 / 私聊推送 / 图片推送 / 广播兜底 / **没有适配器时不取件** / 失败不重发。

手动看一眼「这句话会发出什么」：

```sh
npx tsx test/probe.ts "注册 张三 男"
```

> 对**真核心**的联调脚本（自动搭沙盒、随机端口、跑完还原机器级文件）留在开发工作区里，
> 因为它要读写本机 WayGame 仓库和 `%LOCALAPPDATA%`，不适合放进公开仓库。

## AI 开发声明

**本插件由 AI 编程助手在人类指令下开发。**

- **人类（仓库所有者）** 负责需求、决策、验收与发布；
- **AI** 负责实现、测试与文档，工作规则写在 [`AGENTS.md`](./AGENTS.md)（含红线：不改契约行为、零运行时依赖、改协议必补测试、凭据不进仓库）；
- 第六节那 5 处「对着 WayGame 源码核出来的契约细节」，就是 AI 读源码逐条核对后写下来的 ——
  它们恰好是最容易做错的地方（比如核心其实**不读** `playerId` 字段）。

质量不靠自我声明，靠可复现的验证：

```sh
npm test    # 32 项端到端，任何人 clone 下来都能跑
```

## License

MIT
