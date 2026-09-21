import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { h, type Element, type Logger } from 'koishi'
import type { Config } from './config'
import type { BeeMessageResponse, WayGameImage } from './core-client'

/** 能往会话或频道里塞的东西 */
export type Sendable = string | Element | Element[]
/** 统一的发送口：群里用 Session，主动推送用 bot.sendMessage */
export type Sender = (content: Sendable) => Promise<unknown>

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 去掉常见 Markdown 记号，让 QQ 普通消息读起来干净（核心的 markdown 模板带 # * ` 等） */
export function stripMarkdown(input: string): string {
  return String(input || '')
    .replace(/\`\`\`[\s\S]*?\`\`\`/g, (block) => block.replace(/\`\`\`[^\n]*\n?/g, ''))
    .replace(/\`([^\`]*)\`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 超长文本按换行 / 空格切成多条，避免被平台截断丢内容 */
export function chunkText(text: string, maxLength: number): string[] {
  const source = String(text || '')
  if (!maxLength || maxLength <= 0 || source.length <= maxLength) return source ? [source] : []
  const chunks: string[] = []
  let rest = source
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf('\n', maxLength)
    if (cut < maxLength * 0.5) cut = rest.lastIndexOf(' ', maxLength)
    if (cut < maxLength * 0.5) cut = maxLength
    chunks.push(rest.slice(0, cut).replace(/\s+$/, ''))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

function guessMediaType(path: string): string {
  const lower = String(path || '').toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  return 'image/png'
}

interface ImageAttempt {
  label: string
  build: () => Element
}

/**
 * 按配置排出图片下发方式的尝试顺序。
 * 契约 §7.1：核心同时给 path / url / base64，插件按能力任选；推荐优先级 本地文件 > URL > base64。
 */
export function buildImageAttempts(image: WayGameImage | undefined, fallbackPath: string, config: Config): ImageAttempt[] {
  const path = String((image && image.path) || fallbackPath || '').trim()
  const url = String((image && image.url) || '').trim()
  const mediaType = String((image && image.mediaType) || '') || guessMediaType(path)
  const attempts: ImageAttempt[] = []

  const withFile = (): void => {
    if (!path) return
    let ok = false
    try {
      ok = existsSync(path)
    } catch {
      ok = false
    }
    if (!ok) return
    attempts.push({ label: '本地文件 ' + path, build: () => h.image(pathToFileURL(path).href) })
  }
  const withUrl = (): void => {
    if (!url) return
    attempts.push({ label: 'HTTP 地址 ' + url, build: () => h.image(url) })
  }
  const withBase64 = (): void => {
    const inline = String((image && image.base64) || '').trim()
    if (inline) {
      attempts.push({ label: 'base64（核心返回）', build: () => h.image('data:' + mediaType + ';base64,' + inline) })
      return
    }
    if (!path) return
    try {
      if (!existsSync(path)) return
      const buffer = readFileSync(path)
      attempts.push({ label: 'base64（读本地文件）', build: () => h.image(buffer, mediaType) })
    } catch {
      // 读不出来就算了，交给后面的兜底
    }
  }

  if (config.image.mode === 'file') withFile()
  else if (config.image.mode === 'url') withUrl()
  else if (config.image.mode === 'base64') withBase64()
  else {
    withFile()
    withUrl()
    withBase64()
  }
  return attempts
}

/** 依次尝试各种图片下发方式；全失败返回 false，由调用方回退成文本 */
export async function sendImage(
  send: Sender,
  image: WayGameImage | undefined,
  fallbackPath: string,
  config: Config,
  logger: Logger,
): Promise<boolean> {
  const attempts = buildImageAttempts(image, fallbackPath, config)
  if (!attempts.length) {
    logger.warn('没有可用的图片下发方式（path=%s url=%s）', (image && image.path) || fallbackPath || '', (image && image.url) || '')
    return false
  }
  for (const attempt of attempts) {
    try {
      await send(attempt.build())
      logger.debug('图片已发出（%s）', attempt.label)
      return true
    } catch (error) {
      logger.warn('图片用「%s」发送失败：%s', attempt.label, describeError(error))
    }
  }
  return false
}

/** 发文本：按配置切分，条与条之间留间隔 */
export async function sendText(send: Sender, text: string, config: Config): Promise<boolean> {
  const chunks = chunkText(text, config.text.maxLength)
  if (!chunks.length) return false
  for (let i = 0; i < chunks.length; i++) {
    await send(chunks[i])
    if (i < chunks.length - 1) await sleep(config.text.chunkDelay)
  }
  return true
}

/**
 * 按核心返回的 type 分发一条回复。
 * 铁律（契约 §7）：先看 type —— image 发图，text/markdown 发文本；
 * 图片渲染降级时核心会把 type 改回 markdown/text 并带 imageError，这种要按文本发。
 *
 * @returns 是否真的发出了东西
 */
export async function deliverResponse(
  send: Sender,
  response: BeeMessageResponse,
  config: Config,
  logger: Logger,
): Promise<boolean> {
  const type = String((response && response.type) || 'text').toLowerCase()
  const content = String((response && response.content) == null ? '' : response.content)

  if (type === 'image') {
    const ok = await sendImage(send, response.image, content, config, logger)
    if (ok) return true
    // 空图保护：元数据缺失或被清理时别让玩家什么都收不到
    const notice = String(config.image.fallbackText || '').trim() || '图片生成失败，请稍后再试。'
    const reason = String((response && response.imageError) || '').trim()
    await send(reason ? notice + '（' + reason + '）' : notice)
    return true
  }

  const text = type === 'markdown' && config.text.markdownMode === 'strip' ? stripMarkdown(content) : content
  if (!text.trim()) return false
  return sendText(send, text, config)
}
