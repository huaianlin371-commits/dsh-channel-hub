/**
 * `tests/helpers/comment-spans.ts` 自己的行为用例。
 *
 * 它是「剥注释是否可信」的独立判据（oracle）。判据本身错了，后果比被测对象
 * 错了更糟：`strip-comments-helper.spec.ts` 的全仓回归会**假红**，然后有人
 * 为了让它变绿去改被测实现 —— 把真实现改坏。
 *
 * 这里钉住的就是那条坑：**scanner 不区分上下文**，模板串里内联的
 * `<script>// …</script>` 会被它当成真注释（实测 20 行假红）。
 */
import { describe, expect, it } from 'vitest'

import {
  collectCommentSpans,
  collectLiteralSpans,
  isInsideSpans,
  lineStarts,
} from '../helpers/comment-spans.js'

const text = (source: string, spans: readonly { start: number; end: number }[]): string[] =>
  spans.map((s) => source.slice(s.start, s.end))

describe('collectCommentSpans：真注释一个不漏', () => {
  it('行注释与块注释都能收到', () => {
    const src = ['const a = 1 // 尾注', '/* 块注 */', 'const b = 2'].join('\n')
    expect(text(src, collectCommentSpans(src))).toEqual(['// 尾注', '/* 块注 */'])
  })

  it('多行 JSDoc 是一条区间，不是三条', () => {
    const src = ['/**', ' * 一行', ' * 两行', ' */', 'export const a = 1'].join('\n')
    const spans = collectCommentSpans(src)
    expect(spans).toHaveLength(1)
    expect(src.slice(spans[0]!.start, spans[0]!.end)).toBe('/**\n * 一行\n * 两行\n */')
  })

  it('字符串里的 // 与 /* 都不是注释', () => {
    const src = ["const u = 'https://example.com'", "const s = '/* x */'"].join('\n')
    expect(collectCommentSpans(src)).toEqual([])
  })

  it('★ 模板串里内联的页面脚本注释**不是**本文件的注释', () => {
    // 这就是 scanner 那条坑：本仓 4 个登录页文件里共 20 行这种内联注释。
    const src = [
      'const page = `',
      '  <script>',
      '  // 页面脚本里的注释',
      '  </script>',
      '`',
    ].join('\n')
    expect(collectCommentSpans(src)).toEqual([])
  })

  it('★ 模板串之后的真注释照样能收到', () => {
    const src = ['const page = `', '  // 内联', '`', 'const a = 1 // 真注释'].join('\n')
    expect(text(src, collectCommentSpans(src))).toEqual(['// 真注释'])
  })
})

describe('collectLiteralSpans：字面量区间', () => {
  it('字符串字面量算，标识符不算', () => {
    const src = "const alpha = 'beta'"
    expect(text(src, collectLiteralSpans(src))).toEqual(["'beta'"])
  })

  it('模板串被切成多段，每段都收', () => {
    const src = 'const t = `a${x}b${y}c`'
    const spans = collectLiteralSpans(src)
    // TemplateHead / TemplateMiddle / TemplateTail 三段
    expect(spans.length).toBe(3)
    for (const s of spans) expect(isInsideSpans(s.start, spans)).toBe(true)
  })

  it('${} 里的表达式不算字面量', () => {
    const src = 'const t = `a${"inner"}b`'
    const spans = collectLiteralSpans(src)
    const inner = src.indexOf('"inner"')
    // "inner" 是 StringLiteral，本身是字面量；但 `a` 与 `b` 之间的位置不该被模板段覆盖
    expect(spans.some((s) => s.start === inner)).toBe(true)
  })
})

describe('lineStarts / isInsideSpans', () => {
  it('行首偏移逐行递增且首行为 0', () => {
    const src = 'a\nbb\nccc'
    expect(lineStarts(src)).toEqual([0, 2, 5])
  })

  it('区间是半开的：end 位置不算在内', () => {
    expect(isInsideSpans(0, [{ start: 0, end: 3 }])).toBe(true)
    expect(isInsideSpans(2, [{ start: 0, end: 3 }])).toBe(true)
    expect(isInsideSpans(3, [{ start: 0, end: 3 }])).toBe(false)
  })
})
