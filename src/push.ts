import type { Bot, Context, Logger } from 'koishi'
import type { Config } from './config'
import { CoreOfflineError, type BeeMessageResponse, type PushItem, type WayGameClient } from './core-client'
import { deliverResponse, describeError, markdownElementFor, type Sender } from './dispatch'

/**
 * 主动推送（服务端 → 插件）：契约 §7.2.1 的拉取模式。
 *
 * 为什么用拉取而不是回调：拉取模式下插件不用起 HTTP 服务，核心自带的推送工人整体让路，
 * 「核心推给插件」和「插件来取」不会同时发生 —— 文档里那条「一条推送被投递 4 次、
 * 群里出现 3 条」的事故就是两种模式并存造成的。
 *
 * 回执规则（契约 §7.2.1 的硬要求）：只有确认没发出去才 retry，
 * 否则核心会重发、群里就重复刷屏。
 */
export function startPushLoop(ctx: Context, client: WayGameClient, config: Config): void {
  const logger = ctx.logger('waygame-push')
  if (!config.push.enabled) {
    logger.info('主动推送未启用（push.enabled = false），核心队列需要另外一个插件来取')
    return
  }

  const intervalMs = Math.max(1, Math.round(config.push.interval)) * 1000
  const limit = Math.min(50, Math.max(1, Math.round(config.push.limit)))
  let busy = false
  let modeChecked = false

  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      if (!modeChecked && config.push.autoSwitchToPull) {
        const current = await client.getPushMode()
        if (current && current.mode !== 'pull') {
          await client.setPushMode('pull')
          logger.info('核心推送模式已切到 pull：投递交给插件，核心自带工人让路')
        }
        modeChecked = true
      }
      // 没有可用机器人时**不要取件**："适配器还没连上"是暂时状态，取回来只会回报失败，
      // 等于把消息从队列里烧掉（实测踩到：Koishi 先启动、QQ 适配器后连，
      // 5 条卡住的推送被一次拉取全判成 failed）。留在 pending，等适配器上线再发。
      const bots = candidateBots(ctx, config)
      if (!bots.length) {
        logger.debug('当前没有可用的机器人（适配器还没连上？），这一轮不拉取推送')
        return
      }
      const result = await client.pull(limit)
      const list = (result && result.list) || []
      for (const item of list) {
        await deliverPushItem(bots, client, config, logger, item)
      }
    } catch (error) {
      if (error instanceof CoreOfflineError) {
        logger.debug('核心不在线，这一轮推送跳过：%s', describeError(error))
      } else {
        logger.warn('拉取主动推送失败：%s', describeError(error))
      }
    } finally {
      busy = false
    }
  }

  ctx.setTimeout(() => { void tick() }, 3000)
  ctx.setInterval(() => { void tick() }, intervalMs)
  logger.info('主动推送已启动：每 %d 秒拉一次，每次最多 %d 条', Math.round(intervalMs / 1000), limit)
}

/**
 * 按配置挑机器人：没指定平台就用全部；指定了就只认这个平台
 *（没有就干脆不发，别静默换平台发 —— 那会让玩家在别的平台收到本该发到这儿的消息）
 */
function candidateBots(ctx: Context, config: Config): Bot[] {
  const all = ctx.bots.slice()
  const wanted = String(config.push.platform || '').trim()
  if (!wanted) return all
  return all.filter((bot) => bot.platform === wanted)
}

async function deliverPushItem(
  bots: Bot[],
  client: WayGameClient,
  config: Config,
  logger: Logger,
  item: PushItem,
): Promise<void> {
  let target = String(item.channel_id || item.target_id || '').trim()
  let isPrivate = String(item.channel || '') === 'private'
  // 广播类推送（type=broadcast）核心入队时 target_id 是 null，路由 JOIN 也带不出地址，
  // 插件自己变不出收件人：只能落到配置的广播频道，没配就如实回报失败（别静默丢消息）
  if (!target && String(item.type || '') === 'broadcast') {
    const fallback = String(config.push.broadcastTarget || '').trim()
    if (fallback) {
      target = fallback
      isPrivate = false
    }
  }
  if (!target || !bots.length) {
    // 日志必须能直接告诉人「去改哪儿」，含糊的"投递地址为空"没人看得懂
    let reason: string
    if (target) {
      reason = '当前没有可用的机器人'
    } else if (String(item.type || '') === 'broadcast') {
      reason = '广播类推送没有收件人（核心入队时 target_id 为空）：在插件配置里填 push.broadcastTarget = 群号 才会真的发出去'
    } else {
      reason = '这条推送既没有 channel_id 也没有 target_id，核心没给出任何收件人'
    }
    logger.warn('推送 #%s 无法投递：%s', item.id, reason)
    await safeAck(client, logger, item.id, false, reason, false)
    return
  }

  const msgType = String(item.msg_type || 'text').toLowerCase()
  const payload: BeeMessageResponse = msgType === 'image'
    ? { type: 'image', content: String(item.content || ''), image: { path: String(item.content || '') } }
    : { type: msgType, content: String(item.content || '') }

  let lastError = ''
  for (const bot of bots) {
    const send: Sender = (content) => isPrivate
      ? bot.sendPrivateMessage(target, content as any)
      : bot.sendMessage(target, content as any)
    try {
      const delivered = await deliverResponse(send, payload, config, logger, markdownElementFor(bot.platform))
      if (!delivered) {
        lastError = '推送内容为空'
        continue
      }
      logger.debug('推送 #%s 已发给 %s（%s:%s）', item.id, target, bot.platform, bot.selfId)
      await safeAck(client, logger, item.id, true)
      return
    } catch (error) {
      lastError = describeError(error)
      logger.warn('推送 #%s 通过 %s:%s 发送失败：%s', item.id, bot.platform, bot.selfId, lastError)
    }
  }

  // 发不出去：默认让它停在 failed，等人工 POST /api/push/retry，
  // 因为「可能已经发出去了」时重发会让群里重复收到
  await safeAck(client, logger, item.id, false, lastError || '插件发送失败', config.push.retryOnFailure)
}

async function safeAck(
  client: WayGameClient,
  logger: Logger,
  id: number,
  ok: boolean,
  error?: string,
  retry = false,
): Promise<void> {
  try {
    await client.ack([id], ok, error, retry)
  } catch (error) {
    logger.warn('推送 #%s 回执失败（这条会 60 秒后自动归还）：%s', id, describeError(error))
  }
}
