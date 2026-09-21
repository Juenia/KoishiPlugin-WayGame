import { Context } from 'koishi'
import mock from '@koishijs/plugin-mock'
import * as waygame from '../src/index'
import { MockCore } from './mock-core'

/**
 * 手动烟雾测试：起一个假核心 + 一个最小 Koishi 应用，把插件挂上，
 * 然后在真实群里/私聊里各发一句话，把「玩家看到的回复」原样打出来。
 *
 * 它的价值和 npm test 不同：npm test 是断言，这里是**给人看的**——
 * 想快速确认"这么配到底会发出什么"时跑它。
 *
 *   npx tsx test/probe.ts
 *   npx tsx test/probe.ts "注册 张三 男"    # 指定要发的文本
 */

async function main(): Promise<void> {
  const text = process.argv[2] || '注册 张三 男'
  const core = new MockCore()
  await core.start()

  const app = new Context()
  app.plugin(mock)
  app.plugin(waygame as any, (waygame.Config as any)({ core: { url: core.url }, push: { enabled: false } }))
  await app.start()

  const bot: any = app.bots[0]
  const sent: any[] = []
  bot.sendMessage = async (channelId: string, content: any) => { sent.push({ channelId, content }); return ['probe'] }
  bot.sendPrivateMessage = async (userId: string, content: any) => { sent.push({ userId, content }); return ['probe'] }

  const pretty = (content: any): string => {
    if (typeof content === 'string') return content
    const list = Array.isArray(content) ? content : [content]
    return list.map((el: any) => {
      if (el && el.type === 'text') return String(el.attrs?.content || '')
      if (el && (el.type === 'img' || el.type === 'image')) return '[图片 ' + String(el.attrs?.src || '') + ']'
      return '[' + (el?.type || '?') + ']'
    }).join('')
  }

  console.log('假核心：' + core.url)
  console.log('群里发：' + text)
  const client: any = (app as any).mock.client('10001', '100000')
  void client.receive(text).catch(() => undefined)
  await new Promise((r) => setTimeout(r, 800))

  console.log('核心收到的请求：' + JSON.stringify(core.received[core.received.length - 1]))
  console.log('发回群里的内容：')
  for (const item of sent) console.log('  → ' + pretty(item.content))

  await core.stop()
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})