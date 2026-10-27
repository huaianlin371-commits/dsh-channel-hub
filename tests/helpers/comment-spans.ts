/**
 * 注释 / 字面量区间的**词法器 oracle** —— 给「剥注释是否可信」提供独立判据。
 *
 * ## 为什么需要 oracle
 *
 * `tests/helpers/strip-comments.ts` 是手写状态机，30 个 spec 的源码断言全靠它。
 * 但「它到底剥对了没有」不能用它自己的输出来判：
 *
 * - 输出里残留以 `//` 开头的行，**有两种成因长得一模一样**：
 *   1. **合法保留** —— 模板串里内联的登录页 HTML/JS 自带 `// 中文注释`
 *      （本仓 `astudio-oauth.ts` / `loomy-wechat-login.ts` / `raccoon-login-page.ts` /
 *      `zcode-captcha.ts` 共 20 行），它们在运行时是页面脚本的注释；
 *   2. **真故障** —— 状态机卡在字符串/模板串里出不来，其后整片注释漏剥。
 *
 * 于是需要一个**不依赖状态机**的第三方判据：TypeScript 自己的词法器。
 * 它把源码切成 token 流，`SingleLineCommentTrivia` / `MultiLineCommentTrivia`
 * 就是真注释，`StringLiteral` / `NoSubstitutionTemplateLiteral` / `TemplateHead` /
 * `TemplateMiddle` / `TemplateTail` 的区间就是字面量。
 *
 * ## 两个探针的语义差别（踩过）
 *
 * - `collectCommentSpans` **必须**走 parser（`createSourceFile` + 遍历 AST，
 *   对每个节点取 `getLeadingCommentRanges` / `getTrailingCommentRanges`）：
 *   只有 parser 知道哪些区间是模板串。用 `ts.createScanner(skipTrivia: false)`
 *   会把模板串里内联的 `<script>// …` 当成真注释（实测踩过，20 行假红）。
 * - `collectLiteralSpans` 同样走 parser：模板串在 AST 里被切成 `TemplateHead` /
 *   `TemplateMiddle` / `TemplateTail` 三段（`${}` 之间的部分），中间夹着表达式
 *   节点，所以要**遍历所有节点**收集。
 *
 * ⚠️ 别把 parser 换成 `skipTrivia = true` 的 scanner —— 那样注释直接被跳过，
 * 一个都扫不到（假绿）。
 */
import ts from 'typescript'

/** 源码里的半开区间 `[start, end)`。 */
export interface Span {
  start: number
  end: number
}

/**
 * 源码里**所有真注释**的区间（行注释 + 块注释），按位置升序。
 *
 * ⚠️ 不能用 `ts.createScanner(..., skipTrivia: false)` 扫 —— 实测（2026-10-27）
 * scanner **不区分上下文**，模板串里内联的 `<script>// 页面脚本注释` 会被它
 * 当成真注释吐出来。本仓 `astudio-oauth.ts` 等 4 个文件有 20 行这种内联脚本
 * 注释，用 scanner 当 oracle 会把它们全判成「漏剥」⇒ 用例假红。
 *
 * 正确做法是走 **parser**：AST 已经知道哪些区间是模板串，`getLeadingCommentRanges`
 * / `getTrailingCommentRanges` 只在**节点的 trivia 区**里找注释，天然不越界。
 */
export function collectCommentSpans(source: string): Span[] {
  const file = ts.createSourceFile(
    'oracle.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )
  const seen = new Map<string, Span>()
  const add = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      const key = `${range.pos}-${range.end}`
      if (!seen.has(key)) seen.set(key, { start: range.pos, end: range.end })
    }
  }
  const visit = (node: ts.Node): void => {
    // 节点前的 trivia 里可能有注释（含 JSDoc）。
    add(ts.getLeadingCommentRanges(source, node.getFullStart()))
    // 节点后的同行尾注释（`const a = 1 // x`）只挂在节点的 trailing 上。
    add(ts.getTrailingCommentRanges(source, node.getEnd()))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...seen.values()].sort((a, b) => a.start - b.start)
}

/**
 * 源码里**所有字符串/模板串字面量**的区间。
 *
 * 模板串被切成多段（`TemplateHead` / `TemplateMiddle` / `TemplateTail`），
 * 每段单独收；`${}` 里的表达式**不算**字面量（那是真代码）。
 */
export function collectLiteralSpans(source: string): Span[] {
  const file = ts.createSourceFile(
    'oracle.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )
  const spans: Span[] = []
  const visit = (node: ts.Node): void => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        spans.push({ start: node.getStart(file), end: node.getEnd() })
        break
      default:
        break
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return spans
}

/** `pos` 是否落在任一区间内（区间半开，`pos === start` 算在内）。 */
export function isInsideSpans(pos: number, spans: readonly Span[]): boolean {
  for (const span of spans) {
    if (pos >= span.start && pos < span.end) return true
  }
  return false
}

/** 源码每一行起始偏移（0 基），供「把行号映射回源码位置」用。 */
export function lineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1)
  }
  return starts
}
