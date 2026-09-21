import { Context, h, type Logger, type Session } from 'koishi'
import { Config } from './config'
import { CoreOfflineError, WayGameClient, type BeeMessageRequest, type BeeMessageResponse } from './core-client'
import { deliverResponse, describeError, type Sendable, type Sender } from './dispatch'
import { startPushLoop } from './push'

export { Config } from './config'
export { usage } from './usage'
export const name = 'waygame'


export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('waygame')
  const client = new WayGameClient(logger, () => config)

  // 被动消息：群里 / 私聊说什么都交给核心判断，核心说 unknown 就静默
  ctx.on('message', (session) => {
    handleMessage(session, config, client, logger).catch((error) => {
      logger.warn('处理消息时出错：%s', describeError(error))
    })
  })

  startPushLoop(ctx, client, config)

  ctx.command('waygame.status', '查看 WayGame 对接状态（核心地址 / 在线情况 / 推送队列）', { authority: 3 })
    .action(() => statusReport(client, config))

  // 启动自检：核心在不在、端口对不对，日志里一眼能看到（契约 §2：端口打错只会 404，很难发现）
  ctx.setTimeout(() => { void selfCheck(client, logger) }, 1500)
}

async function handleMessage(
  session: Session,
  config: Config,
  client: WayGameClient,
  logger: Logger,
): Promise<void> {
  const guildId = session.guildId || ''
  if (!config.message.guild && guildId) return
  if (!config.message.direct && !guildId) return
  if (!session.userId || session.userId === session.selfId) return

  if (guildId) {
    if (config.message.groupWhitelist.length && !config.message.groupWhitelist.includes(guildId)) return
    if (config.message.groupBlacklist.includes(guildId)) return
  }

  let text = readText(session)
  if (!text) return
  if (config.message.ignoreCommands && isCommand(text, config)) return

  const prefix = config.message.prefix || ''
  if (prefix) {
    if (!text.startsWith(prefix)) return
    text = text.slice(prefix.length).trim()
    if (!text) return
  }

  const scoped = config.core.playerIdScope === 'scoped' && guildId
  const userId = scoped ? 'bee_' + guildId + '_' + session.userId : session.userId
  const body: BeeMessageRequest = {
    platform: config.core.platform || 'koishi',
    userId,
    text,
  }
  // 私聊不带 groupId：核心靠 groupId 是否为空判断发群还是发好友
  if (guildId) body.groupId = guildId
  // 核心当前忽略 playerId（playerId = userId），照传一份只为排查和兼容文档 §5
  body.playerId = userId
  if (config.push.enabled && config.push.markRoutes) body.plugin_url = 'pull'

  let response: BeeMessageResponse
  try {
    response = await client.sendMessage(body)
  } catch (error) {
    if (error instanceof CoreOfflineError) {
      logger.warn('%s', describeError(error))
      const notice = String(config.message.offlineNotice || '').trim()
      if (notice) await session.send(notice).catch(() => undefined)
      return
    }
    logger.warn('核心处理失败：%s', describeError(error))
    return
  }
  if (!response) return

  const type = String(response.type || 'text').toLowerCase()
  const content = String(response.content == null ? '' : response.content)
  if (config.debug) {
    logger.info('核心返回 type=%s unknown=%s error=%s：%s', type, !!response.unknown, !!response.error, content.slice(0, 160))
  }

  if (response.unknown && !allowUnknown(content, config)) return
  if (!content && type !== 'image') return

  const delivered = await deliverResponse(buildSender(session, config), response, config, logger)
  if (!delivered && config.debug) logger.debug('这条回复没有可发的内容')
}

/** 取玩家发的纯文本：优先用会话内容，拿不到就退回文本元素拼接（附件、表情不会混进来） */
function readText(session: Session): string {
  const content = String(session.content || '').trim()
  if (content) return content
  const elements = session.elements || []
  return elements
    .filter((element) => element.type === 'text')
    .map((element) => String((element.attrs && element.attrs.content) || ''))
    .join('')
    .trim()
}

function isCommand(text: string, config: Config): boolean {
  return config.message.commandPrefixes.some((prefix) => !!prefix && text.startsWith(prefix))
}

/** unknown=true 时的放行规则；默认按契约完全静默 */
function allowUnknown(content: string, config: Config): boolean {
  if (config.message.unknownPolicy === 'always') return true
  if (config.message.unknownPolicy === 'unregistered') return /未注册|请先注册/.test(content)
  return false
}

function buildSender(session: Session, config: Config): Sender {
  const base: Sender = (content) => session.send(content as any)
  const messageId = session.messageId
  if (!config.text.quoteReply || !messageId) return base
  return (content: Sendable) => base([
    h.quote(messageId),
    typeof content === 'string' ? h.text(content) : content,
  ].flat() as any)
}

async function selfCheck(client: WayGameClient, logger: Logger): Promise<void> {
  const endpoint = client.endpoint(true)
  try {
    const status = await client.status()
    const modules = status && Array.isArray(status.modules) ? status.modules.length : 0
    logger.info('已连上 WayGame 核心 %s（端口 %s，模块 %s 个）', endpoint.url, (status && status.port) || '?', modules)
  } catch (error) {
    logger.warn('连不上 WayGame 核心 %s：%s', endpoint.url, describeError(error))
    logger.warn('请确认核心已启动（node server.js）；核心没跑时端口发现文件会被删掉，地址可能不准')
  }
}

async function statusReport(client: WayGameClient, config: Config): Promise<string> {
  const endpoint = client.endpoint(true)
  const lines: string[] = ['【WayGame 对接状态】']
  lines.push('核心地址：' + endpoint.url
    + (endpoint.source === 'default' ? '（默认值：没读到端口发现文件）' : '（来源：' + endpoint.source + '）'))

  try {
    const status = await client.status()
    const modules = status && Array.isArray(status.modules) ? status.modules.length : 0
    lines.push('核心状态：在线（端口 ' + ((status && status.port) || '?') + '，已加载模块 ' + modules + ' 个）')
  } catch (error) {
    lines.push('核心状态：不可达 —— ' + describeError(error))
  }

  try {
    const mode = await client.getPushMode()
    lines.push('推送模式：' + ((mode && mode.mode) || '未知')
      + '｜插件轮询：' + (config.push.enabled ? '开（每 ' + config.push.interval + ' 秒）' : '关'))
  } catch (error) {
    lines.push('推送模式：读取失败 —— ' + describeError(error))
  }

  try {
    const result = await client.pushStatus(5)
    const counts = (result && result.counts) || ({} as any)
    lines.push('推送队列：待取 ' + Number(counts.pending || 0)
      + ' / 已领走 ' + Number(counts.sending || 0)
      + ' / 已送达 ' + Number(counts.sent || 0)
      + ' / 失败 ' + Number(counts.failed || 0))
    if (result && result.hint) lines.push('提示：' + result.hint)
  } catch (error) {
    lines.push('推送队列：读取失败 —— ' + describeError(error))
  }

  return lines.join('\n')
}
