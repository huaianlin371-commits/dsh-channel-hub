#!/usr/bin/env node
/**
 * 注释叙事化的**分级工具**（架构审查 ⑩ 的执行前置）。
 *
 * ## 它解决什么问题
 *
 * `AGENTS.md` 的 ⑩ 口径要求「注释只留约束、过程进 docs/」。但本仓库有
 * **90 个 `src/` 文件**被 spec 用**未剥注释的原文**做字面量断言，而其中大量
 * 字面量**只存在于注释里**（实测：`src/index.ts` 的 `account.create` 只在
 * :1543 的注释出现，`accio-wiring.spec.ts` 却 `toContain` 它）。
 *
 * ⇒ 「删注释」这件事**逐文件成本差异极大**，必须能先知道自己在动哪一档。
 * 批量 sed 会让成片用例假红，而且**红的位置与被改的文件毫无关系**——
 * 那是最难查的一类失败。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/docs-narrative-audit.mjs                # 全局分级
 * node scripts/docs-narrative-audit.mjs src/foo.ts     # 单文件详查
 * ```
 *
 * 不加参数时输出三样：
 *
 * 1. **安全档**（无 raw 文本断言）—— 可放手改注释；
 * 2. **需核对档**（有 raw 文本断言）—— 每条断言都要确认是不是靠注释里的字面量；
 * 3. **当日志用的数字**：各文件的日期叙事密度，用于排优先级。
 *
 * ⚠️ 本脚本**只读**：不算 `--write`，因为它给的是判断依据，不是改写结果。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(REPO, 'src')
const UNIT = join(REPO, 'tests/unit')
const HELPERS = join(REPO, 'tests/helpers')

/** 日期叙事的判据：注释行里出现 ISO 日期。 */
const DATE_RE = /20\d{2}-\d{2}-\d{2}/

/**
 * 剥注释（**与 `tests/helpers/strip-comments.ts` 同口径的简化版**）。
 *
 * ⚠️ 刻意不 import 那个助手：它跑在 vitest 环境里，而本脚本要能独立跑。
 * 两者若漂移，本脚本的结论会**偏保守**（宁可多报风险，不可漏报）。
 */
function stripComments(text) {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      out += c
      i += 1
      while (i < n) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] ?? '')
          i += 2
          continue
        }
        out += text[i]
        if (text[i] === q) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** 统计 `src/` 下每个文件的叙事密度与 reader 分布。 */
function collectSrc() {
  const out = new Map()
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith('.ts')) continue
    const text = readFileSync(join(SRC, name), 'utf8')
    const lines = text.split('\n')
    const commentLines = lines.filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l))
    out.set(name, {
      name,
      lines: lines.length,
      comments: commentLines.length,
      dates: commentLines.filter((l) => DATE_RE.test(l)).length,
      raw: text,
      stripped: stripComments(text),
      rawSpecs: [],
      strippedSpecs: [],
    })
  }
  return out
}

/** 遍历 spec，标明「谁在读这个 src 文件、剥没剥注释」。 */
function attachReaders(srcMap) {
  const specFiles = [
    ...readdirSync(UNIT).filter((f) => f.endsWith('.ts')).map((f) => join(UNIT, f)),
    ...readdirSync(HELPERS).filter((f) => f.endsWith('.ts')).map((f) => join(HELPERS, f)),
  ]
  for (const file of specFiles) {
    const text = readFileSync(file, 'utf8')
    const refs = new Set([...text.matchAll(/src\/([A-Za-z0-9_.-]+\.ts)/g)].map((m) => m[1]))
    if (refs.size === 0) continue
    // 剥过 ⇒ 注释被去掉，删注释不会影响断言。
    const stripped = /stripComments|codeOnly|codeOf|readIndexSource|readRpcSource/.test(text)
    for (const ref of refs) {
      const rec = srcMap.get(ref)
      if (!rec) continue
      ;(stripped ? rec.strippedSpecs : rec.rawSpecs).push(relative(REPO, file))
    }
  }
}

/**
 * 找出「只在注释里成立」的断言字面量。
 *
 * 判据：该字面量在原文里有、在剥注释后的文本里没有 ⇒ 它**只**出现在注释里。
 * 这些点是「删注释就会假红」的精确定位。
 */
function commentOnlyLiterals(rec, specPaths) {
  const found = []
  for (const specPath of specPaths) {
    const text = readFileSync(join(REPO, specPath), 'utf8')
    const re = /(?:toContain|toMatch)\(\s*(?:'([^'\\\n]{6,200})'|\/([^/\n]{6,200})\/)/g
    let m
    while ((m = re.exec(text)) !== null) {
      const lit = m[1] ?? m[2]
      if (!lit) continue
      // 正则要去掉元字符后当普通片段探（保守：探不到就跳过，不误报）。
      const probe = lit.replace(/\\(.)/g, '$1').replace(/[.*+?^${}()|[\]\\]/g, '')
      if (probe.length < 6) continue
      if (rec.raw.includes(probe) && !rec.stripped.includes(probe)) {
        found.push({ spec: specPath, literal: probe.slice(0, 120) })
      }
    }
  }
  return found
}

function reportOne(srcMap, target) {
  const name = target.replace(/^src\//, '')
  const rec = srcMap.get(name)
  if (!rec) {
    console.error(`src/${name} 不存在`)
    process.exitCode = 1
    return
  }
  console.log(`== src/${rec.name}`)
  console.log(`   ${rec.lines} 行，注释 ${rec.comments} 行（${Math.round((100 * rec.comments) / rec.lines)}%）`)
  console.log(`   日期叙事 ${rec.dates} 处`)
  console.log(`   读它的 spec：${rec.rawSpecs.length + rec.strippedSpecs.length} 个`)
  for (const s of rec.strippedSpecs) console.log(`     [剥注释 ✓] ${s}`)
  for (const s of rec.rawSpecs) console.log(`     [原文 ⚠️] ${s}`)

  if (rec.rawSpecs.length === 0) {
    console.log('\n   ✅ 安全档：没有 spec 读它的原文 ⇒ 可放手改注释')
    return
  }

  const dangers = commentOnlyLiterals(rec, rec.rawSpecs)
  if (dangers.length === 0) {
    console.log('\n   ✅ 有原文 reader，但**没有只在注释里成立的断言** ⇒ 改注释前仍建议跑全量')
    return
  }
  console.log(`\n   ⚠️ 需核对：${dangers.length} 条断言的字面量**只在注释里**`)
  for (const d of dangers.slice(0, 25)) console.log(`      ${d.spec}  ←  "${d.literal}"`)
  if (dangers.length > 25) console.log(`      …还有 ${dangers.length - 25} 条`)
}

function reportAll(srcMap) {
  const recs = [...srcMap.values()]
  const safe = recs.filter((r) => r.rawSpecs.length === 0).sort((a, b) => b.dates - a.dates)
  const risky = recs.filter((r) => r.rawSpecs.length > 0).sort((a, b) => b.dates - a.dates)
  const totalDates = recs.reduce((a, b) => a + b.dates, 0)

  console.log('===== ⑩ 注释叙事化：分级 =====\n')
  console.log(`src/ 共 ${recs.length} 个 .ts，日期叙事 ${totalDates} 处\n`)

  console.log(`✅ 安全档（无 spec 读原文，可放手改）：${safe.length} 个`)
  for (const r of safe.slice(0, 15)) {
    console.log(`   ${r.name.padEnd(32)} 日期${String(r.dates).padStart(3)}  注释 ${String(r.comments).padStart(4)}/${String(r.lines).padStart(4)}`)
  }
  if (safe.length > 15) console.log(`   …另有 ${safe.length - 15} 个`)

  console.log(`\n⚠️ 需核对档（有 spec 读原文）：${risky.length} 个`)
  for (const r of risky.slice(0, 15)) {
    console.log(`   ${r.name.padEnd(32)} 日期${String(r.dates).padStart(3)}  raw-specs=${String(r.rawSpecs.length).padStart(2)}`)
  }
  if (risky.length > 15) console.log(`   …另有 ${risky.length - 15} 个`)

  console.log('\n===== 优先顺序（按日期叙事密度）=====')
  for (const r of recs.filter((x) => x.dates >= 8).sort((a, b) => b.dates - a.dates)) {
    const tier = r.rawSpecs.length === 0 ? '安全' : '需核对'
    console.log(`   ${String(r.dates).padStart(3)} 处  [${tier}]  src/${r.name}`)
  }
  console.log('\n单个文件详查：node scripts/docs-narrative-audit.mjs src/<file>.ts')
}

const srcMap = collectSrc()
attachReaders(srcMap)
const arg = process.argv[2]
if (arg) reportOne(srcMap, arg)
else reportAll(srcMap)
