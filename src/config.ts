import { Schema } from 'koishi'

/**
 * koishi-plugin-waygame 的配置构型。
 *
 * 契约依据：<WayGame>/docs/插件接口接入文档.md
 *   - POST /api/bee/message  { platform, groupId, userId, text }
 *   - GET  /api/status                       核心存活探测
 *   - POST /api/push/pull|ack|retry|mode     主动推送（拉取模式）
 */
export interface Config {
  core: {
    /** 核心地址；留空 = 自动读取端口发现文件（推荐） */
    url: string
    /** 上报给核心的平台标识，写进请求体的 platform 字段 */
    platform: string
    /** user = 群聊私聊共用角色；scoped = 每群独立角色 */
    playerIdScope: 'user' | 'scoped'
    /** 单次 HTTP 请求超时（毫秒） */
    timeout: number
  }
  message: {
    guild: boolean
    direct: boolean
    prefix: string
    ignoreCommands: boolean
    commandPrefixes: string[]
    groupWhitelist: string[]
    groupBlacklist: string[]
    unknownPolicy: 'silent' | 'unregistered' | 'always'
    offlineNotice: string
  }
  text: {
    maxLength: number
    chunkDelay: number
    markdownMode: 'text' | 'strip'
    quoteReply: boolean
  }
  image: {
    mode: 'auto' | 'file' | 'url' | 'base64'
    fallbackText: string
  }
  push: {
    enabled: boolean
    interval: number
    limit: number
    autoSwitchToPull: boolean
    markRoutes: boolean
    platform: string
    retryOnFailure: boolean
    broadcastTarget: string
  }
  debug: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    core: Schema.object({
      url: Schema.string().default('').description(
        'WayGame 核心地址，例如 http://127.0.0.1:3555。留空 = 自动读取 %LOCALAPPDATA%\\WayGame\\server-url.txt（推荐，核心换端口后无需改配置）',
      ),
      platform: Schema.string().default('koishi').description('上报给核心的平台标识'),
      playerIdScope: Schema.union([
        Schema.const('user').description('群聊 / 私聊共用同一个角色（推荐，与核心行为一致）'),
        Schema.const('scoped').description('每个群独立角色：上报的 userId 变成 bee_<群号>_<QQ号>'),
      ]).default('user').description('角色隔离方式'),
      timeout: Schema.number().default(15000).min(1000).max(120000).description('HTTP 超时（毫秒）'),
    }).description('核心连接'),

    message: Schema.object({
      guild: Schema.boolean().default(true).description('响应群聊消息'),
      direct: Schema.boolean().default(true).description('响应私聊消息'),
      prefix: Schema.string().default('').description('触发前缀：留空 = 每条消息都交给核心判断（核心对未知指令静默）'),
      ignoreCommands: Schema.boolean().default(true).description('忽略以指令前缀开头的消息，避免和其它插件抢指令'),
      commandPrefixes: Schema.array(Schema.string()).default(['/', '.']).description('指令前缀列表'),
      groupWhitelist: Schema.array(Schema.string()).default([]).description('只响应这些群号（留空 = 不限制）'),
      groupBlacklist: Schema.array(Schema.string()).default([]).description('不响应这些群号'),
      unknownPolicy: Schema.union([
        Schema.const('silent').description('完全静默（契约默认：unknown=true 不发任何消息）'),
        Schema.const('unregistered').description('放行「未注册 / 请先注册」这类提示，其余静默（新玩家不会觉得机器人没反应）'),
        Schema.const('always').description('连未知指令回复也照发（不推荐，群里会显得很吵）'),
      ]).default('silent').description('核心返回 unknown=true 时的处理'),
      offlineNotice: Schema.string().default('').description('核心离线时回复给玩家的一句话；留空 = 静默并在日志里报错'),
    }).description('消息接入'),

    text: Schema.object({
      maxLength: Schema.number().default(2000).min(0).max(20000).description('单条文本最大长度，超出按换行切分（0 = 不切分）'),
      chunkDelay: Schema.number().default(500).min(0).max(10000).description('切分后每条之间的间隔（毫秒）'),
      markdownMode: Schema.union([
        Schema.const('text').description('原样发送 Markdown 源码'),
        Schema.const('strip').description('去掉 Markdown 记号后发送纯文本（QQ 普通群消息更整洁）'),
      ]).default('text').description('markdown 类型回复的处理方式'),
      quoteReply: Schema.boolean().default(false).description('回复时引用玩家原消息'),
    }).description('文本回复'),

    image: Schema.object({
      mode: Schema.union([
        Schema.const('auto').description('依次尝试：本地文件 → URL → base64（推荐）'),
        Schema.const('file').description('只用本地文件（file://，需适配器支持本地路径）'),
        Schema.const('url').description('只用核心的 HTTP 图片地址'),
        Schema.const('base64').description('只用 base64（兼容性最好，流量最大）'),
      ]).default('auto').description('图片下发方式'),
      fallbackText: Schema.string().default('图片生成失败，请稍后再试。').description('图片发不出去时回退的文本'),
    }).description('图片回复'),

    push: Schema.object({
      enabled: Schema.boolean().default(true).description('启用主动推送（定时拉取 push_queue）'),
      interval: Schema.number().default(3).min(1).max(60).description('拉取间隔（秒）'),
      limit: Schema.number().default(10).min(1).max(50).description('每次最多拉取条数'),
      autoSwitchToPull: Schema.boolean().default(true).description('启动时把核心推送模式切成 pull，避免核心自带工人和插件抢消息'),
      markRoutes: Schema.boolean().default(true).description('把玩家路由标记为 pull，核心自带工人就会跳过这些消息'),
      platform: Schema.string().default('').description('用哪个平台的机器人发送推送；留空 = 任意在线机器人'),
      retryOnFailure: Schema.boolean().default(false).description('发送失败时让核心重发（可能造成群里重复，确认发不出去才建议打开）'),
      broadcastTarget: Schema.string().default('').description('广播类推送（核心入队时 target_id 为空的 broadcast）发到哪个群；留空 = 如实回报失败，不静默丢消息'),
    }).description('主动推送'),

    debug: Schema.boolean().default(false).description('输出调试日志'),
  }),
])
