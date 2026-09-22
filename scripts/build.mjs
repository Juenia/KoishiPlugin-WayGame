/**
 * koishi-plugin-waygame 的构建脚本
 * =====================================================================
 * 产出 `lib/`：
 *   lib/index.js      ← 单文件 CJS bundle（esbuild），koishi 外置不打包
 *   lib/*.d.ts        ← 类型声明（tsc，tsconfig 里是 emitDeclarationOnly）
 *
 * 用法：npm run build
 *
 * 为什么不用一行 npm script 搞定：
 *   tsc 开了 composite/incremental，根目录那个 tsconfig.tsbuildinfo 会让它误判「已是最新」
 *   从而**一个 .d.ts 都不生成**（而且不报错）。所以构建前必须把它删掉 —— 这一步得用脚本写。
 *
 * 为什么必须是 --charset=utf8：
 *   esbuild 默认 charset=ascii，会把所有中文转义成 \uXXXX。
 *   运行时虽然等价，但产物会从 37KB 涨到 44KB，而且和之前发布过的 1.0.2 变成两套风格。
 *
 * 为什么加 --types node：
 *   tsconfig 的 compilerOptions.types 里有 `yml-register/types`，那是 Koishi 应用工作区才有的包；
 *   在这个仓库里单独构建会报 TS2688「找不到类型定义文件」。用 --types node 顶掉它即可。
 *
 * 末尾会自检产物（见 verify()），把上面几个坑直接变成"构建失败"而不是"发出去才发现"。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 用 node 直接跑包里的 JS 入口，不走 node_modules/.bin。
 * 为什么：Node 20 起不许直接 spawn `.cmd`（会 EINVAL），而 .bin 在 Windows 上就是 .cmd；
 * 绕开它就不用 shell:true（那会把参数当命令解析，路径带空格/中文就出事）。
 */
function cli(relPath) {
  const file = join(root, 'node_modules', relPath)
  if (!existsSync(file)) {
    console.error('✖ 找不到 ' + relPath + '，先跑 npm install')
    process.exit(1)
  }
  return file
}

function run(label, file, args) {
  process.stdout.write('  · ' + label + '\n')
  execFileSync(process.execPath, [file, ...args], { cwd: root, stdio: 'inherit' })
}

function verify() {
  const bundle = join(root, 'lib', 'index.js')
  const types = join(root, 'lib', 'index.d.ts')
  const problems = []

  if (!existsSync(bundle)) problems.push('lib/index.js 没生成')
  if (!existsSync(types)) problems.push('lib/index.d.ts 没生成（多半是 tsconfig.tsbuildinfo 没删干净）')

  if (existsSync(bundle)) {
    const code = readFileSync(bundle, 'utf8')
    // 忘了 --charset=utf8 的话，esbuild 会把非 ASCII 全转义成 \uXXXX。
    // 正常构建（utf8）里**一处都不会有** —— 所以判据就是"有就失败"，不要用比例/阈值：
    // 第一版我写的是「转义 > 0 且裸中文 < 100」，结果 ascii 构建（转义 2322 处、裸中文仍有 202 个）
    // 直接漏过去了 —— 反向测试当场抓出来，见 构建与发布.md 踩坑 ①。
    const escaped = (code.match(/\\u[0-9a-fA-F]{4}/g) || []).length
    if (escaped > 0) {
      problems.push('lib/index.js 里有 ' + escaped + ' 处 \\uXXXX —— 中文被转义了，检查 --charset=utf8')
    }
    if (!/require\("koishi"\)/.test(code)) {
      problems.push('lib/index.js 里没有 require("koishi") —— koishi 应该外置、不能打进包里')
    }
    if (/^\s*var __commonJS/m.test(code) && !code.includes('__toCommonJS')) {
      problems.push('lib/index.js 看起来不是 CJS bundle')
    }
  }

  if (problems.length) {
    console.error('\n✖ 构建自检没通过：')
    for (const item of problems) console.error('   - ' + item)
    process.exit(1)
  }

  const size = (statSync(bundle).size / 1024).toFixed(1)
  console.log('\n✔ 构建完成：lib/index.js ' + size + ' KB + ' + 'lib/*.d.ts')
}

console.log('构建 koishi-plugin-waygame → lib/')
rmSync(join(root, 'lib'), { recursive: true, force: true })
// ★ 关键一步：不删它，tsc 会认为「已是最新」，lib/*.d.ts 一个都不生成（而且不报错）
rmSync(join(root, 'tsconfig.tsbuildinfo'), { force: true })

run('打包 JS（esbuild · CJS · charset=utf8 · koishi 外置）', cli('esbuild/bin/esbuild'), [
  'src/index.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node18',
  '--charset=utf8',
  '--external:koishi',
  '--outfile=lib/index.js',
])

run('生成类型声明（tsc · emitDeclarationOnly）', cli('typescript/bin/tsc'), [
  '-p', 'tsconfig.json',
  '--types', 'node',
])

verify()
