import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from 'koishi'
import type { Config } from './config'

/**
 * WayGame 核心 HTTP 客户端。
 *
 * 契约来源：<WayGame>/docs/插件接口接入文档.md
 * 关键约定（已对着源码核过）：
 *   - 端口不硬编码：核心启动时把真实地址写进 %LOCALAPPDATA%\WayGame\server-url.txt，
 *     文件在 = 核心活着；核心换端口后插件最多 10 秒自动跟上。
 *   - POST /api/bee/message 的 playerId 字段核心并不读（server.js:833 铁律 playerId = userId），
 *     所以"每群独立角色"要靠改写 userId 实现，见 config.core.playerIdScope。
 *   - 拉取到的推送内容是数据库原文（换行是真实换行）；只有 format:'text' 的 TSV 输出才转义 \n。
 */

/** 出厂默认端口；只有读不到端口发现文件时才兜底用它 */
export const DEFAULT_CORE_URL = 'http://127.0.0.1:3210'

/** 端口发现文件缓存时间（毫秒）：核心换端口后最多这么久自动跟上 */
const DISCOVERY_TTL = 10_000

export interface EndpointInfo {
  url: string
  /** 这个地址是从哪来的，写进日志方便排查 */
  source: string
}

export interface BeeMessageRequest {
  platform?: string
  groupId?: string
  userId: string
  text: string
  /** 文档 §5 的字段；当前核心忽略它，这里保留只为兼容与自查 */
  playerId?: string
  /** 标记玩家路由为 pull：核心自带的推送工人会跳过这个玩家的消息 */
  plugin_url?: string
}

export interface WayGameImage {
  path?: string
  url?: string
  mediaType?: string
  width?: number
  height?: number
  hash?: string
  bytes?: number
  cached?: boolean
  base64?: string
}

export interface BeeMessageResponse {
  content?: string
  type?: string
  error?: boolean | string
  unknown?: boolean
  image?: WayGameImage
  imageError?: string
}

export interface PushItem {
  id: number
  /** player / group / broadcast */
  type: string
  target_id: string
  /** text / markdown / image */
  msg_type: string
  /** msg_type=image 时是图片本地路径 */
  content: string
  created_at?: string
  /** group / private …（核心从 player_routes 带回来的投递地址） */
  channel?: string
  channel_id?: string
}

export interface PushCounts {
  pending: number
  sending: number
  sent: number
  failed: number
}

export interface PushStatus {
  ok?: boolean
  mode?: string
  counts?: PushCounts
  rows?: unknown[]
  hint?: string
}

/** 连不上核心（没启动 / 端口不对 / 被防火墙拦了） */
export class CoreOfflineError extends Error {
  detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'CoreOfflineError'
    this.detail = detail
  }
}

/** 读端口发现文件算出核心地址：配置 > 环境变量 > 发现文件 > 默认值 */
export function discoverEndpoint(explicit: string): EndpointInfo {
  const fromConfig = (explicit || '').trim()
  if (fromConfig) return { url: normalizeUrl(fromConfig), source: '插件配置 core.url' }

  const fromEnv = (process.env.WAYGAME_URL || process.env.WAYGAME_CORE_URL || '').trim()
  if (fromEnv) return { url: normalizeUrl(fromEnv), source: '环境变量 WAYGAME_URL' }

  for (const file of discoveryFiles()) {
    try {
      if (!existsSync(file)) continue
      const url = extractUrl(readFileSync(file, 'utf8'))
      if (url) return { url, source: file }
    } catch {
      // 核心可能正在重写这个文件，读失败就换下一个来源
    }
  }
  return { url: DEFAULT_CORE_URL, source: 'default' }
}

function discoveryFiles(): string[] {
  const files: string[] = []
  const local = process.env.LOCALAPPDATA
  if (local) {
    files.push(join(local, 'WayGame', 'server-url.txt'))
    files.push(join(local, 'WayGame', 'runtime.json'))
  }
  const home = process.env.HOME || process.env.USERPROFILE
  if (home) {
    files.push(join(home, '.local', 'share', 'WayGame', 'server-url.txt'))
  }
  return files
}

function extractUrl(raw: string): string | null {
  const text = String(raw || '').trim()
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text)
      if (data && typeof data.url === 'string' && data.url) return normalizeUrl(data.url)
    } catch {
      return null
    }
    return null
  }
  const matched = text.match(/https?:\/\/[^\s"']+/)
  return matched ? normalizeUrl(matched[0]) : null
}

function normalizeUrl(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '')
}

export class WayGameClient {
  private cache: { info: EndpointInfo; at: number } | null = null
  /** 上一次打过日志的地址：请求失败会清缓存重读发现文件，靠它避免日志刷屏 */
  private lastLogged = ''

  constructor(private logger: Logger, private getConfig: () => Config) {}

  /** 取当前核心地址（带缓存；force=true 强制重新读发现文件） */
  endpoint(force = false): EndpointInfo {
    const now = Date.now()
    if (!force && this.cache && now - this.cache.at < DISCOVERY_TTL) return this.cache.info
    const info = discoverEndpoint(this.getConfig().core.url)
    if (info.url !== this.lastLogged) {
      this.lastLogged = info.url
      if (info.source === 'default') {
        this.logger.warn('没找到 WayGame 端口发现文件，先按默认地址 %s 试（核心可能没在运行）', info.url)
      } else {
        this.logger.info('WayGame 核心地址：%s（来源：%s）', info.url, info.source)
      }
    }
    this.cache = { info, at: now }
    return info
  }

  /** 请求失败后调用：下次重新读端口发现文件 */
  invalidate(): void {
    this.cache = null
  }

  private async request<T>(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
    const { url } = this.endpoint()
    const target = url + path
    const timeout = this.getConfig().core.timeout
    let response: Response
    try {
      response = await fetch(target, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json; charset=utf-8' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (error) {
      this.invalidate()
      const detail = error instanceof Error ? error.message : String(error)
      throw new CoreOfflineError('连不上 WayGame 核心 ' + target + '：' + detail, error)
    }

    const text = await response.text()
    let data: any = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error('核心返回的不是 JSON（HTTP ' + response.status + '）：' + text.slice(0, 200))
      }
    }
    if (!response.ok) {
      // 404：端口指到了别的程序上（文档 §4 明确警告过这种「不报错只 404」的坑）
      if (response.status === 404) this.invalidate()
      const reason = (data && (data.error || data.message)) || text.slice(0, 200) || ''
      throw new Error('核心返回 HTTP ' + response.status + (reason ? '：' + reason : ''))
    }
    return data as T
  }

  /** 核心存活探测：GET /api/status */
  status(): Promise<{ ok?: boolean; port?: number; modules?: string[] }> {
    return this.request('/api/status', undefined, 'GET')
  }

  /** 机器人消息入口：POST /api/bee/message */
  sendMessage(body: BeeMessageRequest): Promise<BeeMessageResponse> {
    return this.request('/api/bee/message', body)
  }

  /** 取推送模式：callback（核心推给插件）/ pull（插件来取） */
  getPushMode(): Promise<{ ok?: boolean; mode?: string }> {
    return this.request('/api/push/mode', undefined, 'GET')
  }

  /** 切推送模式，写 editor_settings.push_mode，下一个 tick 生效 */
  setPushMode(mode: 'pull' | 'callback'): Promise<{ ok?: boolean; mode?: string }> {
    return this.request('/api/push/mode', { mode })
  }

  /**
   * 认领一批待发推送。
   * 不带 plugin 过滤：pull 模式下核心自带的推送工人整体让路，插件就是唯一的投递者，
   * 带过滤反而会漏掉切换模式之前入队、plugin_url 还是旧值的行。
   */
  pull(limit: number): Promise<{ ok?: boolean; list?: PushItem[] }> {
    return this.request('/api/push/pull', { limit })
  }

  /** 送达回执：ok:false 时核心默认不再自动重发（避免群里刷屏） */
  ack(ids: number[], ok: boolean, error?: string, retry = false): Promise<{ ok?: boolean; count?: number; failed?: number[] }> {
    return this.request('/api/push/ack', { ids, ok, retry, error })
  }

  /** 队列状态总览 */
  pushStatus(limit = 10): Promise<PushStatus> {
    return this.request('/api/push/status?limit=' + limit, undefined, 'GET')
  }
}
