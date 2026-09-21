# AGENTS.md · koishi-plugin-waygame

> 给 AI 编程助手（和人类协作者）看的开发指南。动手前**先读完这一页**。
>
> **本项目由 AI 开发**：主体代码、测试、文档由 AI 编程助手在人类下达的指令下产出，
> 人类负责提需求、做决策、验收与发布。

---

## 一句话

把 Koishi 机器人接到 **WayGame 文字游戏核心**。插件**不含任何游戏业务**，只做「转发 + 分发」：
玩家打字 → `POST /api/bee/message` → 按核心返回的 `type` 发回群里。

游戏侧的契约文档是 `WayGame/docs/插件接口接入文档.md`（不在本仓库）。

## 先跑起来，再改

```sh
npm i
npm test                              # 32 项端到端，不需要装游戏本体
npx tsx test/probe.ts "注册 张三 男"   # 手动看一眼「这句话会发出什么」
```

`test/mock-core.ts` 是按契约实现端点的**假核心**，配合 Koishi 官方 `@koishijs/plugin-mock` 造出真实的
Session（群聊 / 私聊都有），所以整条链路是真跑的，只是核心换成了假的。**任何协议行为改动都必须补测试。**

## 目录

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口：被动消息处理、配置构型、`waygame.status` 指令 |
| `src/core-client.ts` | 核心 HTTP 客户端 + **端口发现**（`%LOCALAPPDATA%\WayGame\server-url.txt`） |
| `src/dispatch.ts` | text / markdown / image 分发、长文切分、图片三选一与兜底 |
| `src/push.ts` | 主动推送（拉取模式：pull → 发送 → ack） |
| `src/config.ts` | 配置项（控制台里带中文说明） |
| `src/usage.ts` | 配置页顶部展示的 Markdown（核心包/渲染包下载地址与用法） |
| `test/` | 假核心 + 端到端测试 + 手动烟雾脚本 |

## 铁律（改之前先读，违反即视为 bug）

1. **`unknown=true` 必须静默**。核心没认出的消息一个字都不能发，否则机器人会在群里乱插话。
   放行规则只能通过 `message.unknownPolicy` 配置暴露，不能改默认值。
2. **先看 `type` 再决定怎么发**。图片渲染降级时核心会把 `type` 从 `image` 改回 `markdown`/`text`，
   此时 `content` 是文本 —— 当成图片发就废了。
3. **端口一律靠发现，不许硬编码**。核心换端口后插件要能自动跟上（缓存 10 秒）。
4. **push 回执语义不能动**：只有**确认没发出去**才允许 `retry: true`，否则核心会重发、群里重复刷屏。
5. **零运行时依赖**。只用 Node 内置模块 + `koishi`，不要为了省事引入第三方包。
6. **凭据不进仓库**：`.npmrc` / `.env` 已在 `.gitignore` 里，别挪出去。
7. **改完必须 `npm test` 全绿**，改了协议行为还要同步改断言。

## 几个已经踩过坑的设计决策（别改回去）

| 决策 | 为什么 |
| --- | --- |
| **没有可用机器人时不取件** | 实测踩到：Koishi 先启动、QQ 适配器后连，插件照常拉取，把队列里 5 条消息一次全判成 `failed` —— 等于把消息烧掉。「没有机器人」是暂时状态，留在 `pending` 等适配器上线即可 |
| **拉取不带 plugin 过滤** | pull 模式下核心自带的推送工人整体让路，插件就是唯一投递者；带过滤反而会漏掉「切换模式之前入队」的行 |
| **`playerIdScope: scoped` 改写 userId** | 核心的 `/api/bee/message` 写死了 `playerId = userId`（`server.js` 注释「铁律」），文档说的传 `playerId` 实现群隔离**不会生效**，只能改写 `userId` |
| **失败默认不 retry** | 只有确认没发出去才允许重发，见铁律 4 |
| **地址日志只在变化时打** | 请求失败会清地址缓存 → 重新发现 → 每 3 秒刷一遍日志，实测刷屏 |

## 对接契约的 5 处坑（详细版见 `readme.md` 第六节）

1. 核心不读 `playerId` 字段
2. 只有 TSV（`format: 'text'`）才转义换行，JSON 拉取是原文，**不要做 `\n` 还原**
3. `unknown` 的判定包含「请先注册」→ 新玩家会被静默
4. `callback` / `pull` 两种推送模式不能共存
5. 图片降级靠 `type` 判断

## 发布

```sh
# 构建在 Koishi 应用根目录做（本仓库是被 workspace 链接进去的）
cd ..\.. && npm run build
cd external/waygame && npm pack --dry-run
npm publish --registry=https://registry.npmjs.org --access public
```

`lib/` 是构建产物、已在 `.gitignore` 里，但**必须存在于 npm 包里**（`files: ["lib", "readme.md"]`）。
发布前记得先 build，否则包是空的。

## 提交信息

用中文写清楚「改了什么 + 为什么」，涉及契约的改动要写明依据（哪份文档 / 哪段源码）。
