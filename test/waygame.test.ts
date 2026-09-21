import { Context, h, Universal } from 'koishi'
import mock from '@koishijs/plugin-mock'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as waygame from '../src/index'
import { discoverEndpoint } from '../src/core-client'
import { deliverResponse, markdownElementFor } from '../src/dispatch'
import { MockCore } from './mock-core'

/**
 * koishi-plugin-waygame 的端到端测试。
 *
 * 为什么这么测：Koishi 官方 mock 插件能造出真的 Session（群聊 / 私聊都有），
 * 假核心按《WayGame 插件接口接入文档》实现端点，
 * 于是"玩家打字 → 插件 → 核心 → 回复"整条链路都是真跑的，只是核心换成了假核心。
 *
 * 运行：npm test（= tsx test/waygame.test.ts）
 */

const GROUP = '100000'
const USER = '10001'

let passed = 0
let failed = 0
const failures: string[] = []
let current = ''

async function test(name: string, fn: () => Promise<void>, timeout = 10000): Promise<void> {
  current = name
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('超时 ' + timeout + 'ms')), timeout)),
    ])
    passed++
    console.log('  [OK]   ' + name)
  } catch (error) {
    failed++
    const message = error instanceof Error ? error.message : String(error)
    failures.push(name + ' → ' + message)
    console.log('  [FAIL] ' + name + '\n         ' + message)
  }
}

function section(title: string): void {
  console.log('\n=== ' + title + ' ===')
}

interface Harness {
  app: Context
  sent: Array<{ channelId?: string; userId?: string; content: any }>
}

/** 起一个真 Koishi 应用，只把机器人换成本地 mock；发送全部截留在 sent 里 */
async function createApp(overrides: Record<string, any> = {}): Promise<Harness> {
  const app = new Context()
  app.plugin(mock)
  app.plugin(waygame as any, (waygame.Config as any)(overrides))
  await app.start()
  const bot: any = app.bots[0]
  const sent: Harness['sent'] = []
  bot.sendMessage = async (channelId: string, content: any) => {
    sent.push({ channelId, content })
    return ['mock-' + sent.length]
  }
  bot.sendPrivateMessage = async (userId: string, content: any) => {
    sent.push({ userId, content })
    return ['mock-p' + sent.length]
  }
  return { app, sent }
}

/** 群聊发一条消息（不等回包，用 waitFor 等结果，避开 mock 对异步监听器的时序限制） */
function sendGroup(harness: Harness, text: string, userId = USER, groupId = GROUP): void {
  const client: any = (harness.app as any).mock.client(userId, groupId)
  void client.receive(text).catch(() => undefined)
}

/** 私聊发一条消息 */
function sendPrivate(harness: Harness, text: string, userId = USER): void {
  const client: any = (harness.app as any).mock.client(userId)
  void client.receive(text).catch(() => undefined)
}

/** 手工造会话派发：用来给 session 带上 authority 等 mock 客户端不暴露的字段 */
function dispatchEvent(harness: Harness, event: Record<string, any>): void {
  const bot: any = harness.app.bots[0]
  const content = String(event.content || '')
  const session = bot.session({
    type: 'message',
    selfId: bot.selfId,
    user: { id: event.userId || USER, authority: event.authority, name: event.userId || USER },
    message: { id: 'raw-' + Date.now(), content, elements: h.parse(content) },
    guild: event.groupId ? { id: event.groupId } : undefined,
    channel: event.groupId
      ? { id: event.groupId, type: Universal.Channel.Type.TEXT }
      : { id: 'private:' + (event.userId || USER), type: Universal.Channel.Type.DIRECT },
  })
  bot.dispatch(session)
}

async function waitFor(predicate: () => boolean, label: string, timeout = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('等待超时：' + label)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把 Koishi 的发送内容（字符串或 element 数组）压成可断言的文本 */
function toText(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  const list = Array.isArray(content) ? content : [content]
  return list
    .map((element: any) => {
      if (typeof element === 'string') return element
      if (element && element.type === 'text') return String((element.attrs && element.attrs.content) || '')
      if (element && (element.type === 'img' || element.type === 'image')) return '<图片:' + String((element.attrs && element.attrs.src) || '') + '>'
      return '<' + ((element && element.type) || '?') + '>'
    })
    .join('')
}

function firstImage(content: any): any {
  const list = Array.isArray(content) ? content : [content]
  return list.find((element: any) => element && (element.type === 'img' || element.type === 'image'))
}

/* --------------------------------------------------- 发送层单测的小工具 */

const MD = '**加粗标题**\n> 引用一行'

/** 取默认配置（schemastery 实例可以直接当函数调用，顺带把默认值补齐） */
function defaults(overrides: Record<string, any> = {}): any {
  return (waygame.Config as any)(overrides)
}

/** 记录"发出去的东西"的假发送口 */
function makeSink(): { got: any[]; send: (content: any) => Promise<unknown[]> } {
  const got: any[] = []
  return { got, send: async (content: any) => { got.push(content); return [] } }
}

const silentLogger: any = { debug() {}, info() {}, warn() {}, error() {}, success() {} }

/** 递归取出元素树里的纯文本（qq:markdown 会把源码放在子节点里） */
function deepText(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  const list = Array.isArray(content) ? content : [content]
  return list.map((element: any) => {
    if (typeof element === 'string') return element
    if (element.type === 'text') return String((element.attrs && element.attrs.content) || '')
    return deepText(element.children)
  }).join('')
}

async function main(): Promise<void> {
  const core = new MockCore()
  await core.start()
  console.log('假 WayGame 核心已启动：' + core.url)

  // ---------------------------------------------------------------- 端口发现
  section('端口发现（不碰机器上真实的 server-url.txt）')

  const realLocalAppData = process.env.LOCALAPPDATA
  const realEnv = process.env.WAYGAME_URL

  await test('配置项优先于一切', async () => {
    assert.equal(discoverEndpoint('http://127.0.0.1:9999/').url, 'http://127.0.0.1:9999')
    assert.equal(discoverEndpoint('http://127.0.0.1:9999/').source, '插件配置 core.url')
  })

  await test('读 %LOCALAPPDATA%\\WayGame\\server-url.txt', async () => {
    const fake = mkdtempSync(join(tmpdir(), 'waygame-local-'))
    mkdirSync(join(fake, 'WayGame'))
    writeFileSync(join(fake, 'WayGame', 'server-url.txt'), 'http://127.0.0.1:7777\n')
    process.env.LOCALAPPDATA = fake
    delete process.env.WAYGAME_URL
    const info = discoverEndpoint('')
    assert.equal(info.url, 'http://127.0.0.1:7777')
    assert.ok(info.source.includes('server-url.txt'), '来源应指向端口发现文件，实际：' + info.source)
    rmSync(fake, { recursive: true, force: true })
  })

  await test('没有 server-url.txt 时退回 runtime.json', async () => {
    const fake = mkdtempSync(join(tmpdir(), 'waygame-local2-'))
    mkdirSync(join(fake, 'WayGame'))
    writeFileSync(join(fake, 'WayGame', 'runtime.json'), JSON.stringify({ host: '127.0.0.1', port: 6666, url: 'http://127.0.0.1:6666' }))
    process.env.LOCALAPPDATA = fake
    const info = discoverEndpoint('')
    assert.equal(info.url, 'http://127.0.0.1:6666')
    assert.ok(info.source.includes('runtime.json'), '来源：' + info.source)
    rmSync(fake, { recursive: true, force: true })
  })

  await test('环境变量 WAYGAME_URL 可用', async () => {
    process.env.WAYGAME_URL = 'http://127.0.0.1:8888'
    const info = discoverEndpoint('')
    assert.equal(info.url, 'http://127.0.0.1:8888')
    assert.equal(info.source, '环境变量 WAYGAME_URL')
    if (realEnv === undefined) delete process.env.WAYGAME_URL
    else process.env.WAYGAME_URL = realEnv
  })

  await test('什么线索都没有时退回默认端口', async () => {
    const fake = mkdtempSync(join(tmpdir(), 'waygame-local3-'))
    process.env.LOCALAPPDATA = fake
    delete process.env.WAYGAME_URL
    const info = discoverEndpoint('')
    assert.equal(info.url, 'http://127.0.0.1:3210')
    assert.equal(info.source, 'default')
    rmSync(fake, { recursive: true, force: true })
  })

  if (realLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = realLocalAppData

  // ---------------------------------------------------------------- 被动消息
  section('被动消息：群聊 → 核心 → 回复')

  const main1 = await createApp({ core: { url: core.url }, push: { enabled: false } })

  await test('注册：文本回复原样发出，请求体符合契约', async () => {
    const before = core.received.length
    sendGroup(main1, '注册')
    await waitFor(() => main1.sent.length === 1, '机器人回复')
    assert.equal(toText(main1.sent[0].content), '欢迎来到万象世界，角色创建成功！')
    assert.equal(main1.sent[0].channelId, GROUP)
    assert.equal(core.received.length, before + 1)
    const request: any = core.received[core.received.length - 1]
    assert.equal(request.userId, USER)
    assert.equal(request.groupId, GROUP)
    assert.equal(request.text, '注册')
    assert.equal(request.platform, 'koishi')
    assert.equal(request.playerId, USER, 'playerId 应等于 userId（核心铁律）')
    assert.equal(request.plugin_url, undefined, '主动推送关掉时不该去抢玩家路由（那是别的插件的地盘）')
  })

  await test('未知指令：unknown=true 时完全静默', async () => {
    const before = main1.sent.length
    sendGroup(main1, '今天天气不错')
    await sleep(600)
    assert.equal(main1.sent.length, before, '不该发任何消息')
  })

  await test('私聊也能走通', async () => {
    const before = main1.sent.length
    sendPrivate(main1, '注册')
    await waitFor(() => main1.sent.length === before + 1, '私聊回复')
    assert.equal(toText(main1.sent[main1.sent.length - 1].content), '欢迎来到万象世界，角色创建成功！')
    assert.equal(core.received[core.received.length - 1].groupId, undefined)
  })

  await test('图片回复：走本地文件（file://）', async () => {
    const before = main1.sent.length
    sendGroup(main1, '地图')
    await waitFor(() => main1.sent.length === before + 1, '图片回复')
    const image = firstImage(main1.sent[main1.sent.length - 1].content)
    assert.ok(image, '应该发的是图片元素，实际：' + JSON.stringify(main1.sent[main1.sent.length - 1].content))
    const src = String(image.attrs.src || '')
    assert.ok(src.startsWith('file://'), 'auto 模式优先本地文件，实际 src=' + src)
    assert.ok(src.includes('shot.png'), 'src 应指向核心给的缓存文件：' + src)
  })

  await test('空图保护：图片路径失效时回退成可读文本', async () => {
    const before = main1.sent.length
    sendGroup(main1, '图坏了')
    await waitFor(() => main1.sent.length === before + 1, '兜底文本')
    const text = toText(main1.sent[main1.sent.length - 1].content)
    assert.ok(text.includes('图片生成失败'), '应给出兜底提示，实际：' + text)
    assert.ok(text.includes('缓存已被清理'), '应带上 imageError 原因，实际：' + text)
  })

  await test('玩家自己的消息不会引起自问自答', async () => {
    const before = main1.sent.length
    const bot: any = main1.app.bots[0]
    sendGroup(main1, '注册', bot.selfId)
    await sleep(400)
    assert.equal(main1.sent.length, before)
  })

  await test('核心返回 500 时不往群里发脏数据', async () => {
    const before = main1.sent.length
    core.failNextMessage = true
    sendGroup(main1, '注册')
    await sleep(600)
    assert.equal(main1.sent.length, before)
  })

  await test('带前缀的消息会被忽略，前缀命中时剥掉前缀再送核心', async () => {
    const app = await createApp({ core: { url: core.url }, push: { enabled: false }, message: { prefix: '游戏' } })
    const before = core.received.length
    sendGroup(app, '注册')
    await sleep(400)
    assert.equal(core.received.length, before, '没有前缀不该送核心')
    sendGroup(app, '游戏 注册')
    await waitFor(() => core.received.length === before + 1, '前缀命中')
    assert.equal(core.received[core.received.length - 1].text, '注册')
  })

  await test('群白名单：只响应名单内的群', async () => {
    const app = await createApp({ core: { url: core.url }, push: { enabled: false }, message: { groupWhitelist: ['999999'] } })
    const before = core.received.length
    sendGroup(app, '注册', USER, '100000')
    await sleep(400)
    assert.equal(core.received.length, before, '白名单外的群不该送核心')
    sendGroup(app, '注册', USER, '999999')
    await waitFor(() => core.received.length === before + 1, '白名单内的群')
    assert.equal(core.received[core.received.length - 1].groupId, '999999')
  })

  await test('指令前缀：/ 开头的不抢', async () => {
    const app = await createApp({ core: { url: core.url }, push: { enabled: false } })
    const before = core.received.length
    sendGroup(app, '/waygame.status')
    await sleep(400)
    assert.equal(core.received.length, before)
  })

  await test('每群独立角色（scoped）：上报 bee_<群号>_<QQ号>', async () => {
    const app = await createApp({ core: { url: core.url, playerIdScope: 'scoped' }, push: { enabled: false } })
    sendGroup(app, '注册', '20002', '555555')
    await waitFor(() => core.received.some((item) => item.userId === 'bee_555555_20002'), '群内独立角色')
    sendPrivate(app, '注册', '20002')
    await waitFor(() => core.received.some((item) => item.userId === '20002' && !item.groupId), '私聊用原始 QQ 号')
  })

  await test('unknownPolicy=unregistered：新玩家能看到「请先注册」', async () => {
    const app = await createApp({ core: { url: core.url }, push: { enabled: false }, message: { unknownPolicy: 'unregistered' } })
    const before = app.sent.length
    sendGroup(app, '未注册')
    await waitFor(() => app.sent.length === before + 1, '放行未注册提示')
    assert.equal(toText(app.sent[app.sent.length - 1].content), '请先注册')
  })

  await test('markdown 回复：strip 模式去掉记号', async () => {
    const app = await createApp({ core: { url: core.url }, push: { enabled: false }, text: { markdownMode: 'strip' } })
    sendGroup(app, '公告')
    await waitFor(() => app.sent.length === 1, 'markdown 回复')
    assert.equal(toText(app.sent[0].content), '开服公告\n今晚八点攻城')
  })

  await test('markdown 回复：text 模式原样发出', async () => {
    const app = await createApp({ core: { url: core.url }, push: { enabled: false } })
    sendGroup(app, '公告')
    await waitFor(() => app.sent.length === 1, 'markdown 回复')
    assert.equal(toText(app.sent[0].content), '**开服公告**\n> 今晚八点攻城')
  })

  await test('长文本按换行切成多条', async () => {
    const app = await createApp({ core: { url: core.url }, push: { enabled: false }, text: { maxLength: 200, chunkDelay: 0 } })
    sendGroup(app, '长文')
    await waitFor(() => app.sent.length >= 3, '切分后的多条消息')
    for (const item of app.sent) {
      assert.ok(toText(item.content).length <= 200, '每条都不该超过 200 字')
    }
  })

  await test('核心离线：按配置给出提示', async () => {
    const app = await createApp({ core: { url: 'http://127.0.0.1:1' }, push: { enabled: false }, message: { offlineNotice: '核心没开，稍后再试' } })
    sendGroup(app, '注册')
    await waitFor(() => app.sent.length === 1, '离线提示')
    assert.equal(toText(app.sent[0].content), '核心没开，稍后再试')
  })

  await test('核心离线且未配置提示时保持静默', async () => {
    const app = await createApp({ core: { url: 'http://127.0.0.1:1' }, push: { enabled: false } })
    sendGroup(app, '注册')
    await sleep(800)
    assert.equal(app.sent.length, 0)
  })

  await test('waygame.status 指令能报出核心与队列状态', async () => {
    const app = await createApp({ core: { url: core.url }, push: { enabled: false } })
    dispatchEvent(app, { userId: USER, content: 'waygame.status', authority: 3 })
    await waitFor(() => app.sent.length === 1, '指令回复')
    const text = toText(app.sent[0].content)
    assert.ok(text.includes('核心地址'), '实际：' + text)
    assert.ok(text.includes(core.url), '应带上核心地址，实际：' + text)
    assert.ok(text.includes('核心状态：在线'), '应报在线，实际：' + text)
    assert.ok(text.includes('推送队列'), '应报队列，实际：' + text)
  })

  // ---------------------------------------------------------------- markdown 发送
  section('markdown 回复：原生元素 vs 纯文本')

  await test('平台映射：只有 qq 有原生 markdown 元素', async () => {
    assert.equal(markdownElementFor('qq'), 'qq:markdown')
    assert.equal(markdownElementFor('QQ'), 'qq:markdown')
    assert.equal(markdownElementFor('onebot'), undefined)
    assert.equal(markdownElementFor(''), undefined)
  })

  await test('auto + QQ：发的是 qq:markdown 元素，源码原样保留', async () => {
    const sink = makeSink()
    await deliverResponse(sink.send, { type: 'markdown', content: MD }, defaults(), silentLogger, markdownElementFor('qq'))
    assert.equal(sink.got.length, 1, '应该只发一条')
    const element: any = sink.got[0]
    assert.equal(typeof element, 'object', 'auto 模式下发的应该是元素而不是字符串：' + JSON.stringify(element))
    assert.equal(element.type, 'qq:markdown', '实际类型：' + element.type)
    assert.equal(deepText(element), MD, '源码必须原样进元素，记号不能被吃掉')
  })

  await test('auto + 不支持的平台：退回源码纯文本', async () => {
    const sink = makeSink()
    await deliverResponse(sink.send, { type: 'markdown', content: MD }, defaults(), silentLogger, markdownElementFor('onebot'))
    assert.equal(sink.got.length, 1)
    assert.equal(sink.got[0], MD)
  })

  await test('mode=text：平台支持也发纯文本源码', async () => {
    const sink = makeSink()
    await deliverResponse(sink.send, { type: 'markdown', content: MD }, defaults({ text: { markdownMode: 'text' } }), silentLogger, 'qq:markdown')
    assert.equal(sink.got[0], MD)
  })

  await test('mode=strip：去记号发纯文本', async () => {
    const sink = makeSink()
    await deliverResponse(sink.send, { type: 'markdown', content: MD }, defaults({ text: { markdownMode: 'strip' } }), silentLogger, 'qq:markdown')
    assert.ok(!String(sink.got[0]).includes('**'), '不该留记号：' + sink.got[0])
    assert.ok(String(sink.got[0]).includes('加粗标题'))
  })

  await test('原生元素发失败时退回纯文本（不能让玩家什么都收不到）', async () => {
    const got: any[] = []
    const send = async (content: any) => {
      if (typeof content !== 'string') throw new Error('适配器不认识这个元素')
      got.push(content)
      return []
    }
    await deliverResponse(send, { type: 'markdown', content: MD }, defaults(), silentLogger, 'qq:markdown')
    assert.equal(got.length, 1, '应该刚好有一条回退后的纯文本')
    assert.equal(got[0], MD)
  })

  // ---------------------------------------------------------------- 主动推送
  section('主动推送：核心 → 插件（拉取模式）')

  // 注意：同一个假核心只能有一个拉取者，否则谁先抢到谁发，断言会飘
  const pushApp = await createApp({
    core: { url: core.url },
    push: { enabled: true, interval: 1, limit: 5, autoSwitchToPull: true, broadcastTarget: '777777' },
  })

  await test('没有任何适配器时不拉取推送（否则会把队列里的消息烧成 failed）', async () => {
    const lonely = new MockCore()
    await lonely.start()
    try {
      // 故意不装 mock 插件：ctx.bots 为空，模拟"Koishi 先起、QQ 适配器还没连"
      const bare = new Context()
      bare.plugin(waygame as any, (waygame.Config as any)({ core: { url: lonely.url }, push: { enabled: true, interval: 1, limit: 5 } }))
      await bare.start()
      lonely.enqueue({ type: 'player', target_id: '10001', channel: 'group', channel_id: '100000', content: '适配器没连时不该被取走' })
      await sleep(2500)
      assert.equal(lonely.pulledIds.length, 0, '不该取件')
      assert.equal(lonely.acks.length, 0, '更不该回报失败')
    } finally {
      await lonely.stop().catch(() => undefined)
    }
  }, 20000)

  await test('启动后自动把核心推送模式切到 pull', async () => {
    await waitFor(() => core.pushMode === 'pull', '推送模式切换', 6000)
  })

  await test('开启推送时把玩家路由标记为 pull', async () => {
    const before = core.received.length
    sendGroup(pushApp, '注册')
    await waitFor(() => core.received.length === before + 1, '消息进核心')
    assert.equal(core.received[core.received.length - 1].plugin_url, 'pull')
  })

  await test('群推送：拉到 → 发到群 → 回执 ok', async () => {
    const item = core.enqueue({ type: 'player', target_id: USER, channel: 'group', channel_id: GROUP, msg_type: 'text', content: '离线收益到账：+100 金币' })
    await waitFor(() => pushApp.sent.some((entry) => toText(entry.content).includes('离线收益')), '推送送达')
    const sent = pushApp.sent.find((entry) => toText(entry.content).includes('离线收益'))
    assert.equal(sent?.channelId, GROUP)
    await waitFor(() => core.acks.some((ack) => ack.ids.includes(item.id) && ack.ok), '回执 ok:true')
  })

  await test('私聊推送：按 channel=private 发好友', async () => {
    const item = core.enqueue({ type: 'player', target_id: USER, channel: 'private', channel_id: USER, msg_type: 'text', content: '你的角色已恢复体力' })
    await waitFor(() => pushApp.sent.some((entry) => toText(entry.content).includes('恢复体力')), '私聊推送')
    const sent = pushApp.sent.find((entry) => toText(entry.content).includes('恢复体力'))
    assert.equal(sent?.userId, USER, '私聊应走 sendPrivateMessage')
    await waitFor(() => core.acks.some((ack) => ack.ids.includes(item.id) && ack.ok), '私聊回执')
  })

  await test('图片推送：msg_type=image 时把 content 当图片路径发', async () => {
    const item = core.enqueue({ type: 'player', target_id: USER, channel: 'group', channel_id: GROUP, msg_type: 'image', content: core.imagePath })
    await waitFor(() => pushApp.sent.some((entry) => firstImage(entry.content)), '图片推送')
    const entry = pushApp.sent.find((item2) => firstImage(item2.content))
    const image = firstImage(entry?.content)
    assert.ok(String(image.attrs.src).startsWith('file://'), '实际：' + String(image.attrs.src))
    await waitFor(() => core.acks.some((ack) => ack.ids.includes(item.id) && ack.ok), '图片推送回执')
  })

  await test('广播推送（target_id 为空）按配置落到广播频道', async () => {
    const item = core.enqueue({ type: 'broadcast', target_id: '', channel: '', channel_id: '', msg_type: 'text', content: '全服公告：今晚八点攻城' })
    await waitFor(() => pushApp.sent.some((entry) => toText(entry.content).includes('今晚八点攻城')), '广播送达')
    const delivered = pushApp.sent.find((entry) => toText(entry.content).includes('今晚八点攻城'))
    assert.equal(delivered?.channelId, '777777')
    await waitFor(() => core.acks.some((ack) => ack.ids.includes(item.id) && ack.ok), '广播回执')
  })

  await test('广播推送没配广播频道时如实回报失败，不静默丢消息', async () => {
    // 单独一个假核心：避免和 pushApp 抢同一条队列
    const lonely = new MockCore()
    await lonely.start()
    try {
      const app = await createApp({ core: { url: lonely.url }, push: { enabled: true, interval: 1, limit: 5 } })
      const item = lonely.enqueue({ type: 'broadcast', target_id: '', channel: '', channel_id: '', msg_type: 'text', content: '没人收的广播' })
      await waitFor(() => lonely.acks.some((ack) => ack.ids.includes(item.id)), '失败回执')
      const ack = lonely.acks.find((entry) => entry.ids.includes(item.id))
      assert.equal(ack?.ok, false, '应回报失败而不是假装送达')
      assert.ok(String(ack?.error || '').includes('广播类推送没有收件人'), '失败原因要说清楚，实际：' + ack?.error)
      assert.ok(String(ack?.error || '').includes('broadcastTarget'), '失败原因要直接告诉人去改哪个配置，实际：' + ack?.error)
      assert.equal(app.sent.length, 0, '无处可发时不该乱发')
    } finally {
      await lonely.stop().catch(() => undefined)
    }
  })

  await test('发送失败默认不重发（避免群里重复刷屏）', async () => {
    const bot: any = pushApp.app.bots[0]
    const original = bot.sendMessage
    bot.sendMessage = async () => { throw new Error('模拟发送失败') }
    const item = core.enqueue({ type: 'player', target_id: USER, channel: 'group', channel_id: GROUP, msg_type: 'text', content: '这条注定发不出去' })
    await waitFor(() => core.acks.some((ack) => ack.ids.includes(item.id)), '失败回执')
    const ack = core.acks.find((entry) => entry.ids.includes(item.id))
    assert.equal(ack?.ok, false)
    assert.notEqual(ack?.retry, true, '默认不该带 retry，否则核心会重发导致刷屏')
    bot.sendMessage = original
  })

  // ---------------------------------------------------------------- 收尾
  console.log('\n========================================')
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项')
  if (failures.length) {
    console.log('失败明细：')
    for (const item of failures) console.log('  - ' + item)
  }
  await core.stop().catch(() => undefined)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error('测试直接崩了：', error)
  process.exit(1)
})