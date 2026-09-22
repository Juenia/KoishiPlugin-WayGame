/**
 * 插件配置页顶部展示的说明（Koishi 控制台按 Markdown 渲染）。
 *
 * 两块内容：
 *   ① **置顶的「更新核心包」**（2026-09-23 加）：把当前**热更新版本**取回来显示在这里，
 *      并给出「已经有核心了就用 update.exe 一键更新」这条最短路径；
 *   ② 剩下的「拿核心包 → 装渲染包 → 不用配地址 → 怎么验证」新手路径。
 *
 * 版本号为什么要动态取：核心是**热更**的，插件发版时印死的版本号过两天就过期了。
 * 这里在插件启动时拉一次 `hotfix/manifest.json`（薄薄一层，零依赖），失败**完全静默** ——
 * 取不到就退化成静态文案，绝不影响插件运行，也绝不因为网络问题让配置页开不出来。
 */
const RELEASE_BASE = 'https://github.com/Juenia/KoishiPlugin-WayGame/releases'
const CORE_PACKAGE_URL = RELEASE_BASE + '/download/WayGameCore/WayGameCore.zip'
const RENDER_PACKAGE_URL = RELEASE_BASE + '/download/WayGameCore/WayGameRender.zip'
const RELEASES_PAGE = RELEASE_BASE
const CORE_REPO = 'https://github.com/Juenia/WayGameCore'

/** 核心热更清单（raw 直链）—— 版本号就从这儿来 */
export const HOTFIX_MANIFEST_URL = 'https://raw.githubusercontent.com/Juenia/WayGameCore/main/hotfix/manifest.json'
/** 自动刷新间隔：6 小时 */
export const HOTFIX_REFRESH_INTERVAL = 6 * 60 * 60 * 1000

export interface HotfixInfo {
  /** 热更清单里的 coreVersion */
  version: string
  /** 发布时刻（清单里的 releasedAt，可能为空） */
  releasedAt: string
  /** 本次更新说明（清单里的 notes） */
  notes: string[]
  /** 本地取到的时刻（毫秒） */
  checkedAt: number
}

/** 最近一次取到的热更信息；没取到过就是 null */
let hotfix: HotfixInfo | null = null
/** 最近一次失败原因（只用来在页面上写一句实话） */
let hotfixError = ''

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 置顶的「更新核心包」区块 */
function renderHotfixSection(): string[] {
  const out: string[] = ['### 🔄 更新核心包', '']

  if (hotfix) {
    out.push('> **热更新版本：`' + hotfix.version + '`** ｜ ' + formatTime(hotfix.checkedAt) + ' 从热更源取到')
    if (hotfix.notes.length) out.push('> 本次更新：' + hotfix.notes.join(' · '))
  } else {
    out.push('> **热更新版本：暂时取不到**'
      + (hotfixError ? '（' + formatTime(Date.now()) + ' 检查失败：' + hotfixError + '）' : '（尚未检查）'))
    out.push('> 不影响使用 —— 直接打开 [热更源](' + CORE_REPO + ') 看最新版，或到 [Releases](' + RELEASES_PAGE + ') 下整包')
  }
  out.push('')

  out.push('- **还没有核心包** → 下载 [WayGameCore.zip](' + CORE_PACKAGE_URL + ')（29 MB，必装）')
  out.push('- **已经有核心了** → 双击核心目录里的 **`update.exe`** 就能拉到最新版，**不用重新下整包**；'
    + '更新坏了还能 `update.exe rollback` 退回上一版（只留最近两版备份）')
  out.push('- **想要图片消息** → 再下 [WayGameRender.zip](' + RENDER_PACKAGE_URL + ')（139 MB，解压到核心根目录即可）')
  out.push('')
  out.push('热更源：[Juenia/WayGameCore](' + CORE_REPO + ') ｜ 历史版本：[Releases](' + RELEASES_PAGE + ')')
  out.push('')
  out.push('---')
  out.push('')
  return out
}

/** 拼出配置页顶部的完整 Markdown */
export function renderUsage(): string {
  return renderHotfixSection().concat([
    '## WayGame 文字游戏核心 · 对接插件',
    '',
    '把 Koishi 机器人接到 **WayGame 文字游戏核心**：玩家在群里打字 → 核心跑完游戏逻辑 → 插件把回复发回群里。',
    '本插件不含任何游戏业务，**WayGame 那边一行代码都不用改**。',
    '',
    '### 一、先下载游戏本体',
    '',
    '| 包 | 大小 | 下载 | 说明 |',
    '| --- | --- | --- | --- |',
    '| **核心包**（必装） | 29 MB | [WayGameCore.zip](' + CORE_PACKAGE_URL + ') | 核心 + 编辑器 + 游戏数据 + 教程文档 |',
    '| **渲染包**（可选） | 139 MB | [WayGameRender.zip](' + RENDER_PACKAGE_URL + ') | Electron 离屏渲染引擎，想要图片消息才装 |',
    '',
    '历史版本与后续更新：' + RELEASES_PAGE,
    '',
    '1. 解压**核心包**到任意目录（路径别带中文和空格），双击 **启动核心.bat**（需要 Node.js 18+）',
    '2. 想改数据就开 **编辑器\\WayGameEditor.exe**，改完在编辑器左下角重启核心',
    '3. 装了之后想让核心保持最新：双击核心目录里的 **update.exe**（它就是干这个的，不用开编辑器）',
    '',
    '> 只装核心包也能玩：文本 / Markdown 消息完全正常，图片消息会自动降级成文本，不报错。',
    '',
    '### 二、想要图片消息就再装渲染包',
    '',
    '把**渲染包**解压到**核心包根目录**，会合并出 `node_modules\\electron`，之后 `type=image` 的房间就能出图。',
    '',
    '> 渲染端口 = 编辑器「基础设置 → 渲染端口」（默认 3212）。同一台机器跑多个核心时，',
    '> 第二个必须改成别的端口，否则会连上第一个的渲染进程、报 unauthorized 并静默降级。',
    '',
    '### 三、这里不用填核心地址（重要）',
    '',
    '核心启动时会把**真实地址**写到 `%LOCALAPPDATA%\\WayGame\\server-url.txt`，插件读它即可：',
    '',
    '- 核心换了端口，插件最多 10 秒自动跟上 —— **不要在这里手填端口**',
    '- 文件存在 = 核心在跑；文件不存在 = 核心没跑（插件只记一条日志，不会乱发消息）',
    '- 只有核心跑在**别的机器**上，才需要填「核心地址」',
    '',
    '### 四、怎么验证通了',
    '',
    '按顺序查：',
    '',
    '1. 核心在跑吗 —— 浏览器打开 `http://127.0.0.1:<核心端口>/api/status`，应返回 `{"ok":true,...}`',
    '2. 适配器连了吗 —— 控制台「插件配置 → adapter」里 OneBot / QQ 官方机器人是否在线',
    '   （QQ 官方机器人只推 **@机器人** 的消息，群里要 `@机器人 注册 昵称 男`）',
    '3. 群里发 `注册 昵称 男`，正常会收到一张角色卡',
    '4. 还是没有？打开本页的「调试」开关，看日志里的 `waygame` 行',
    '5. Markdown 没渲染、直接显示成 `**加粗**` 这种源码？—— 插件默认（`text.markdownMode: auto`）会对',
    '   QQ 官方机器人发原生 Markdown，其它适配器只能发源码。先确认「插件配置 → adapter」里用的是官方 QQ 机器人。',
    '',
    '### 五、自带指令',
    '',
    '| 指令 | 权限 | 作用 |',
    '| --- | --- | --- |',
    '| `waygame.status` | 3 | 查看核心地址、在线情况、推送队列 |',
    '',
    '### 六、玩家在群里怎么玩',
    '',
    '触发词由核心的 `custom_commands` 表决定（默认 103 条）：`注册` `角色` `地图` `背包` `攻击` …',
    '核心没认出来的消息会返回 `unknown`，插件**默认一个字都不发**，所以机器人不会在群里乱插话。',
    '',
    '### 七、交流与反馈',
    '',
    '**交流群（QQ 群）：1121395453** —— 装包、报错、提需求都可以在群里问。',
    '',
    '问题也可以提到 [GitHub Issues](' + RELEASES_PAGE.replace('/releases', '/issues') + ')。',
    '',
    '---',
    '',
    '> 本插件由 AI 开发（见 [AGENTS.md](' + RELEASES_PAGE.replace('/releases', '/blob/main/AGENTS.md') + ')），质量靠可复现的测试。',
    '',
  ]).join('\n')
}

/**
 * 配置页顶部那份 Markdown。
 *
 * 用 `let` 而不是 `const`：取到热更版本后要**原地换掉**它。
 * `src/index.ts` 是用 `export { usage } from './usage'` 转出去的，编译成 CommonJS 后是个 getter，
 * 所以 Koishi 每次打开配置页读到的都是最新值（这一点由测试 `配置页顶部会跟着刷新` 钉住）。
 */
export let usage = renderUsage()

/** 当前热更信息（给测试和排查用） */
export function currentHotfix(): HotfixInfo | null { return hotfix }

/**
 * 拉一次热更清单，把版本号刷进配置页顶部。
 * **永不抛异常**：网络不通/清单格式变了都只是记一句 `hotfixError`，返回 null。
 */
export async function refreshHotfix(options: { url?: string, timeoutMs?: number } = {}): Promise<HotfixInfo | null> {
  const url = options.url || HOTFIX_MANIFEST_URL
  const timeoutMs = options.timeoutMs || 8000
  if (typeof fetch !== 'function') return null
  try {
    const response = await fetch(url, {
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      headers: { 'User-Agent': 'koishi-plugin-waygame' },
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const data: any = await response.json()
    const version = String((data && data.coreVersion) || '').trim()
    if (!version) throw new Error('清单里没有 coreVersion')
    hotfix = {
      version,
      releasedAt: String((data && data.releasedAt) || ''),
      notes: Array.isArray(data && data.notes) ? data.notes.map((x: any) => String(x)).slice(0, 4) : [],
      checkedAt: Date.now(),
    }
    hotfixError = ''
    usage = renderUsage()
    return hotfix
  } catch (error) {
    // 静默降级：配置页照常打开，只是显示「暂时取不到」
    hotfixError = error instanceof Error ? error.message : String(error)
    usage = renderUsage()
    return null
  }
}
