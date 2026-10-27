/**
 * `tests/helpers/strip-comments.ts` 自己的行为用例。
 *
 * ## 为什么这个助手需要自己的测试
 *
 * 它是 **30 个 spec 的共用前置**（2026-10-27 架构审查 ⑤ 收敛前，这些 spec 各自
 * 抄了一份实现，实测出 15 种互不相同的行为）。助手写错的后果不是「一条用例红」，
 * 而是**几十条接线断言集体假绿或假红**——收敛过程中就真踩了两次：
 *
 * 1. 照搬 `llm-adapter.spec.ts` 那份实现时，模板串**永远不闭合**
 *    （`if (c === quote && state !== 'template')`）⇒ 源码里只要出现过一处反引号，
 *    其后所有注释都不再被剥。在 `src/index.ts` 上实测：保留 221 666 字符 vs
 *    正确的 88 739 字符，13 万字符的注释留在「代码」里。
 * 2. 不识别**正则字面量** ⇒ `jet-hub.js` 里的 `/"/g` 被当成字符串开头，
 *    后面一大段注释漏剥 ⇒ `notice-shape` / `new-account-dialog` 两条
 *    `not.toMatch` 假红。
 *
 * 所以这里逐条钉住那些形态。**这些用例红了就说明全仓的源码断言都不可信了**，
 * 优先级高于任何一个具体 spec。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stripComments, stripCommentsDetailed } from '../helpers/strip-comments.js'
import { collectCommentSpans, lineStarts } from '../helpers/comment-spans.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('stripComments：注释必须剥干净', () => {
  it('行注释整行消失', () => {
    expect(stripComments('const a = 1 // 诱饵\nconst b = 2\n')).not.toContain('诱饵')
  })

  it('块注释整段消失', () => {
    expect(stripComments('/* 诱饵 */\nconst a = 1\n')).not.toContain('诱饵')
  })

  it('多行 JSDoc 的正文行也要消失（只剥首尾行是不够的）', () => {
    const src = ['/**', ' * 诱饵：`fetchFor: geminiFetchForAccount`', ' */', 'const a = 1'].join('\n')
    const out = stripComments(src)
    expect(out).not.toContain('诱饵')
    expect(out).not.toContain('geminiFetchForAccount')
    expect(out).toContain('const a = 1')
  })

  it('注释里孤立的块注释起始符不会把后面的真码一起吃掉', () => {
    // 正则版在这里会与「后面」的 */ 配对，把 `const real = 1` 整段删掉。
    const src = ['/* 这里提到 /* 一个起始符', 'const real = 1', '*/', 'const after = 2'].join('\n')
    const out = stripComments(src)
    expect(out).not.toContain('const real = 1')
    expect(out).toContain('const after = 2')
  })

  it('行号不漂移：输出与输入的换行数一致', () => {
    const src = ['/**', ' * a', ' * b', ' */', 'const x = 1 // tail', 'const y = 2'].join('\n')
    expect(stripComments(src).split('\n').length).toBe(src.split('\n').length)
  })
})

describe('stripComments：字面量必须保留（否则会误删真码）', () => {
  it("字符串里的 `//` 不当注释（'https://…'）", () => {
    const out = stripComments("const u = 'https://example.com/a'\n")
    expect(out).toContain('https://example.com/a')
  })

  it('字符串里的 `/*` 不当块注释', () => {
    const out = stripComments("const s = '/* not a comment */'\nconst after = 1\n")
    expect(out).toContain('/* not a comment */')
    expect(out).toContain('const after = 1')
  })

  it('字符串里的转义引号不会提前闭合', () => {
    const out = stripComments("const s = 'a\\'b' // 诱饵\n")
    expect(out).toContain("'a\\'b'")
    expect(out).not.toContain('诱饵')
  })

  it('模板串里的 `//` 与 `${}` 原样保留', () => {
    const out = stripComments('const t = `http://x/${id}//y`\n')
    expect(out).toContain('http://x/${id}//y')
  })

  it('★ 模板串必须能闭合：其后出现的注释仍要被剥掉', () => {
    // llm-adapter 那份原实现进模板串后永不回 code，这条会红。
    const out = stripComments('const t = `x`\n// 诱饵\nconst after = 1\n')
    expect(out).not.toContain('诱饵')
    expect(out).toContain('const after = 1')
  })

  it('★ 正则字面量里的引号不开启字符串态（/"/g）', () => {
    // jet-hub.js 的 csvCell 就是 `text.replace(/"/g, '""')`：
    // 不识别正则 ⇒ 当成字符串开头 ⇒ 后面整段注释漏剥。
    const src = ['const s = v.replace(/"/g, \'""\')', '// 诱饵', 'const after = 1'].join('\n')
    const out = stripComments(src)
    expect(out).toContain('replace(/"/g')
    expect(out).not.toContain('诱饵')
    expect(out).toContain('const after = 1')
  })

  it('★ 正则字面量里的 // 不被当行注释', () => {
    const out = stripComments("const re = /a\\/\\/b/\nconst after = 1\n")
    expect(out).toContain('const after = 1')
  })

  it('除法不会被误当正则开头', () => {
    const out = stripComments('const half = total / 2 // 诱饵\n')
    expect(out).toContain('total / 2')
    expect(out).not.toContain('诱饵')
  })
})

describe('★ 全仓回归：真实源码剥完后状态机必须收在 code', () => {
  /** 递归收集 `src/` 与 `plugin-src/` 下的 .ts/.js 文件。 */
  const collect = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) {
        if (name === 'node_modules' || name === 'lib') continue
        collect(abs, out)
      } else if (/\.(ts|js)$/.test(name)) {
        out.push(abs)
      }
    }
    return out
  }

  const repo = resolve(here, '../..')
  const files = [...collect(join(repo, 'src')), ...collect(join(repo, 'plugin-src'))]

  it('扫描面够大（防止收集逻辑坏掉后这条静默通过）', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('没有任何文件在字符串/模板串里脱轨（收尾状态 + 栈深）', () => {
    // 「输出里还剩 `//` 行」判不出真假：模板串里内联的登录页 HTML/JS 自带
    // `// 中文注释`（合法保留），状态机脱轨时整片注释也以同样形态留下。
    // 真判据是状态机自己的收尾：正常文件跑完必是 code（或 line：末行是注释
    // 且没有行尾换行），且模板串栈必须清空。
    const derailed: string[] = []
    for (const file of files) {
      const d = stripCommentsDetailed(readFileSync(file, 'utf8'))
      const okState = d.endState === 'code' || d.endState === 'line'
      if (!okState || d.stackDepth !== 0) {
        derailed.push(
          `${file.slice(repo.length + 1)} endState=${d.endState} stackDepth=${d.stackDepth}`,
        )
      }
    }
    expect(derailed).toEqual([])
  })

  it('★ 用 TypeScript 词法器当 oracle：残留的 `//` 行必须全部落在字面量里', () => {
    // 这条是「剥注释是否可信」的独立判据，不依赖状态机自己。
    // 词法器说某行有真注释、状态机却把它留下了 ⇒ 漏剥（会污染所有源码断言）。
    const leaked: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const d = stripCommentsDetailed(source)
      if (d.keptCommentLines.length === 0) continue
      const commentSpans = collectCommentSpans(source)
      const starts = lineStarts(source)
      for (const lineNo of d.keptCommentLines) {
        const lineStart = starts[lineNo - 1]
        if (lineStart === undefined) continue
        const lineEnd = starts[lineNo] ?? source.length
        // 该行上有没有真注释的起点？
        const hasRealComment = commentSpans.some((s) => s.start >= lineStart && s.start < lineEnd)
        if (hasRealComment) {
          leaked.push(`${file.slice(repo.length + 1)}:${lineNo}`)
        }
      }
    }
    expect(leaked).toEqual([])
  })
})
