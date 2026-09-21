import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 假 WayGame 核心：按 <WayGame>/docs/插件接口接入文档.md 的契约实现端点，
 * 用来在不起真核心的情况下跑插件的端到端测试。
 *
 * 覆盖的端点：GET /api/status、POST /api/bee/message、
 * GET|POST /api/push/mode、POST /api/push/pull|ack|retry、GET /api/push/status
 */

/** 1x1 的合法 PNG，用来当"核心渲染出来的图" */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export interface RecordedMessage {
  platform?: string
  groupId?: string
  userId?: string
  text?: string
  playerId?: string
  plugin_url?: string
}

export interface PushRow {
  id: number
  type: string
  target_id: string
  msg_type: string
  content: string
  created_at: string
  channel?: string
  channel_id?: string
}

export class MockCore {
  readonly received: RecordedMessage[] = []
  readonly acks: Array<{ ids: number[]; ok: boolean; retry?: boolean; error?: string }> = []
  readonly queue: PushRow[] = []
  readonly pulledIds: number[] = []
  pushMode = 'callback'
  imagePath = ''
  imageUrl = ''
  port = 0
  url = ''
  failNextMessage = false

  private server = createServer((req, res) => {
    this.handle(req, res).catch((error) => this.json(res, 500, { error: String(error && error.message || error) }))
  })

  async start(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'waygame-mock-'))
    this.imagePath = join(dir, 'shot.png')
    writeFileSync(this.imagePath, Buffer.from(PNG_BASE64, 'base64'))

    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.url = 'http://127.0.0.1:' + this.port
    this.imageUrl = this.url + '/img/shot.png'
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** 往队列塞一条待推送，模拟核心的 push() */
  enqueue(row: Partial<PushRow> = {}): PushRow {
    const id = this.queue.length + 1
    const item: PushRow = {
      id,
      type: row.type || 'player',
      // 用 == null 判断而不是 ||：广播类推送要能显式塞空串（核心真实行为是 target_id 为 null）
      target_id: row.target_id == null ? '10001' : row.target_id,
      msg_type: row.msg_type || 'text',
      content: row.content == null ? '离线收益到账：+100 金币' : row.content,
      created_at: new Date().toISOString(),
      channel: row.channel == null ? 'group' : row.channel,
      channel_id: row.channel_id == null ? '100000' : row.channel_id,
    }
    this.queue.push(item)
    return item
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || ''
    const method = req.method || 'GET'
    const body = await readJson(req)

    if (method === 'GET' && url === '/api/status') {
      return this.json(res, 200, { ok: true, port: this.port, modules: ['player', 'battle', 'bag'] })
    }

    if (method === 'POST' && url === '/api/bee/message') {
      this.received.push(body as RecordedMessage)
      if (this.failNextMessage) {
        this.failNextMessage = false
        return this.json(res, 500, { content: '', error: '模拟核心内部错误' })
      }
      return this.json(res, 200, this.replyFor(String(body.text || '')))
    }

    if (url === '/api/push/mode') {
      if (method === 'GET') return this.json(res, 200, { ok: true, mode: this.pushMode })
      if (method === 'POST') {
        this.pushMode = String(body.mode || '')
        return this.json(res, 200, { ok: true, mode: this.pushMode })
      }
    }

    if (method === 'POST' && url === '/api/push/pull') {
      const limit = Math.max(1, Math.min(50, Number(body.limit) || 10))
      const list = this.queue.filter((row) => !this.pulledIds.includes(row.id)).slice(0, limit)
      for (const row of list) this.pulledIds.push(row.id)
      return this.json(res, 200, { ok: true, list })
    }

    if (method === 'POST' && url === '/api/push/ack') {
      const ids = Array.isArray(body.ids) ? body.ids : []
      this.acks.push({ ids, ok: body.ok !== false, retry: body.retry === true, error: body.error })
      if (body.ok === false && body.retry === true) {
        for (const id of ids) {
          const index = this.pulledIds.indexOf(id)
          if (index >= 0) this.pulledIds.splice(index, 1)
        }
      }
      return this.json(res, 200, { ok: true, count: ids.length, failed: [] })
    }

    if (method === 'POST' && url === '/api/push/retry') {
      this.pulledIds.length = 0
      return this.json(res, 200, { ok: true, count: this.queue.length, ids: [] })
    }

    if (url === '/api/push/status' || url.startsWith('/api/push/status?')) {
      const sent = this.acks.filter((ack) => ack.ok).reduce((sum, ack) => sum + ack.ids.length, 0)
      const failed = this.acks.filter((ack) => !ack.ok).reduce((sum, ack) => sum + ack.ids.length, 0)
      return this.json(res, 200, {
        ok: true,
        mode: this.pushMode,
        counts: {
          pending: this.queue.length - this.pulledIds.length,
          sending: this.pulledIds.length - sent - failed,
          sent,
          failed,
        },
        rows: [],
        hint: '假核心：队列 ' + this.queue.length + ' 条',
      })
    }

    return this.json(res, 404, { ok: false, error: '未知 API：' + url })
  }

  /** 按文本决定回复，覆盖 text / markdown / image / unknown 四种形态 */
  private replyFor(text: string): Record<string, unknown> {
    const t = text.trim()
    if (t.includes('地图')) {
      return {
        content: this.imagePath,
        type: 'image',
        error: false,
        unknown: false,
        image: {
          path: this.imagePath,
          url: this.imageUrl,
          mediaType: 'image/png',
          width: 1,
          height: 1,
          hash: 'mock',
          bytes: 70,
          cached: true,
          base64: PNG_BASE64,
        },
      }
    }
    if (t.includes('图坏了')) {
      return { content: 'C:\\nowhere\\gone.png', type: 'image', error: false, unknown: false, imageError: '缓存已被清理' }
    }
    if (t.includes('公告')) {
      return { content: '**开服公告**\n> 今晚八点攻城', type: 'markdown', error: false, unknown: false }
    }
    if (t.includes('长文')) {
      return { content: Array.from({ length: 8 }, (_, i) => '第' + (i + 1) + '行：' + '内容'.repeat(30)).join('\n'), type: 'text', error: false, unknown: false }
    }
    if (t.includes('未注册')) {
      return { content: '请先注册', type: 'text', error: false, unknown: true }
    }
    if (t.includes('注册')) {
      return { content: '欢迎来到万象世界，角色创建成功！', type: 'text', error: false, unknown: false }
    }
    return { content: '未知指令，请查看帮助', type: 'text', error: false, unknown: true }
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    const buffer = Buffer.from(JSON.stringify(data), 'utf8')
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buffer.length })
    res.end(buffer)
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}