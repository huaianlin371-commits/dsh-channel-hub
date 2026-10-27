/**
 * 剥掉注释 —— **接线类源码断言的共用前置**。
 *
 * ## ⚠️ 为什么这是「断言的前置」而不是可选的清理
 *
 * 本仓库反复记录过的同一族假绿：`if (false)` 这类**短路禁用**对源码文本断言
 * 完全无感 —— 字面量在死分支里、在注释里都照样能被正则命中。IKLTZ2 的两次
 * 独立审计实测到两种形态：
 *
 * - M09：把 `fetchFor: geminiFetchForAccount,` 整行删掉、只把字面量塞进
 *   **注释** ⇒ 判据 `/fetchFor:\s*geminiFetchForAccount/` 依然全绿；
 * - M29：把 `if (method.startsWith('gemini.'))` 改成
 *   `if (globalThis.X === true && method.startsWith('gemini.'))`（**字面量完整保留
 *   在死条件里**）⇒ 只做 `indexOf` + 位置比较的判据同样全绿。
 *
 * ⇒ 任何 `toMatch` / `indexOf` 型接线断言都必须先过这个函数。
 *
 * ## ⚠️ 它**不能**替代行为用例
 *
 * 剥注释只解决「注释诱饵」，**解决不了「分支恒不执行」**（上例 M29 的死条件
 * 里没有注释）。那种形态只能用**行为**断言守（真的调一次端点，看它有没有生效）。
 * 本文件因此在每个 spec 里都保留了若干条**行为**用例，源码断言只用来守
 * 「接线点在不在」这一较弱的不变式。
 *
 * ## 实现：状态机 + 模板串嵌套栈，而不是正则
 *
 * 本仓库历史上 30 个 spec 各自抄了一份「正则版」，实测出 **15 种互不相同**的实现，
 * 它们的假绿/假红形态各不相同（2026-10-27 架构审查 ⑤ 收敛前统计）：
 *
 * - **非贪婪块注释正则的经典假绿**：遇到注释里孤立的块注释起始符，正则会拿它
 *   与**后面**那个块注释结束符配对 ⇒ 把中间的真实代码整段吃掉 ⇒ 反向断言恒绿；
 * - **只剥「整行是块注释」的行也不行**：本仓库的 JSDoc 是多行的，只剥首尾行会
 *   剩下若干以 `*` 开头的正文行，里面的示例字面量被当真码 ⇒ 假红；
 * - **`(^|[^:])\/\/` 保留 URL** 的变体则漏掉 `http://` 之后的行注释；
 * - **按行前缀过滤**的变体会把字符串字面量里以 `//` 开头的行整行删掉。
 *
 * 所以这里用状态机：代码 / 行注释 / 块注释 / 字符串 / 模板串。
 * 注释整段丢弃，**换行保留**（行数与原文一致，行号不会漂移），
 * 字符串字面量原样保留（`'https://…'` 里的 `//` 不会被误当注释）。
 *
 * ## ⚠️ 模板串里的 `${}` 必须单独当一层（2026-10-27 修）
 *
 * 只认「反引号开关模板串」是**不够**的：`${…}` 里面是**真正的 JS 表达式**，
 * 表达式里可以再出现字符串、正则、甚至**嵌套模板串**：
 *
 * ```ts
 * const url = `${base}/x?q=${encodeURIComponent(
 *   `https://h/auth?${params}`,   // ← 嵌套模板串，反引号成对
 * )}`
 * ```
 *
 * 按「反引号就翻转模板态」处理时，上面这段会把内层开引号当成外层闭引号 ⇒
 * 模板态与代码态**交替错位**，最终整体卡在模板态。实测 `src/officeace-auth.ts`
 * 从第 312 行起卡死，其后 **1200+ 行注释全部漏剥**（该文件 1867 行），
 * 7 处 `//` 注释被当成「代码」留在输出里。所以这里维护一个栈：
 * 进模板串压 `template`，遇到 `${` 压 `expr` 并回到代码态，
 * `expr` 里按花括号深度计数、深度归零才弹栈回模板态。
 *
 * 已知边界：正则字面量靠「前一个有效记号」判定（见 `regexAllowed`）。
 * 这对 `src/` 与 `plugin-src/` 的现有写法足够 —— `plugin-src/client/jet-hub.js`
 * 里就有 `/"/g`、`/^\s*[=+@-]/` 这类**引号在正则里**的字面量，不识别它们会被
 * 当成字符串开头，进而把后面一大段注释漏剥（实测 `notice-shape` 与
 * `new-account-dialog` 两条 `not.toMatch` 因此假红）。
 *
 * 另一条已知边界：模板串里**内联的 HTML/JS**（`<script>` 里那种 `// 中文注释`）
 * 属于模板串文本，按「字面量原样保留」处理，不会被剥掉 —— 这是对的，
 * 那些 `//` 在运行时是页面脚本的注释，不是本文件的注释。
 */

/** 这些记号之后出现的 `/` 是正则开头，不是除号。 */
const REGEX_AFTER_CHARS = '(,=:[!&|?{;+-*%~^<>'

/** 这些关键字之后出现的 `/` 是正则开头。 */
const REGEX_AFTER_WORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'instanceof',
  'new', 'do', 'else', 'yield', 'await', 'throw',
])

/**
 * 判断此刻的 `/` 是否开启一个正则字面量。
 *
 * 依据是**前一个有效记号**：运算符/开括号/逗号之后必然是表达式起点 ⇒ 正则；
 * 标识符、`)`、`]`、字面量之后 ⇒ 除号。JS 词法里没有更简单的判据。
 */
function regexAllowed(out: string): boolean {
  let i = out.length - 1
  while (i >= 0 && /\s/.test(out[i]!)) i--
  if (i < 0) return true
  const ch = out[i]!
  if (REGEX_AFTER_CHARS.includes(ch)) return true
  if (/[\w$]/.test(ch)) {
    let j = i
    while (j >= 0 && /[\w$]/.test(out[j]!)) j--
    return REGEX_AFTER_WORDS.has(out.slice(j + 1, i + 1))
  }
  return false
}

/** 模板串嵌套栈的一层：正在模板文本里，或正在 `${}` 表达式里。 */
type TemplateFrame =
  | { kind: 'template' }
  | { kind: 'expr'; depth: number }

/**
 * 剥注释的**诊断版**：除了结果文本，还回报状态机自己的体检指标。
 *
 * 为什么需要它 —— 光看「输出里还剩几行 `//`」判不出真假：
 *
 * - **合法保留**：模板串里内联的 HTML/JS（登录页脚本）本来就有 `// 中文注释`，
 *   它们在运行时是页面脚本的注释，不是本文件的注释，必须原样保留；
 * - **真故障**：状态机卡在字符串/模板串里出不来 ⇒ 其后所有注释都漏剥。
 *
 * 两种形态在输出里长得一样（都是「还剩 `//` 行」），但 `endState` 不同：
 * 前者跑完仍是 `code`，后者停在 `template`/`single`/`double` 或栈没清空。
 */
export interface StripDiagnostics {
  /** 剥完的文本。 */
  text: string
  /**
   * 状态机跑到文件尾时的状态。
   *
   * 正常文件只可能是 `'code'`，或 `'line'`（文件最后一行是注释且**没有**
   * 行尾换行 —— 那种情况下注释照样被剥掉了，只是没机会回到 code）。
   * 落在这两者之外 ⇒ 状态机在字符串/模板串里脱轨，**其后所有注释都漏剥**。
   */
  endState: 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  /** 跑到文件尾时模板串栈的剩余深度；正常文件必然是 0。 */
  stackDepth: number
  /**
   * 输出里仍以 `//` 开头的行号（1 基）。
   *
   * ⚠️ 这个数字**判不出对错**，别拿它当断言：模板串里内联的 HTML/JS 本来
   * 就带 `//` 注释（合法保留），而状态机脱轨时整片注释也会以同样形态留下。
   * 真假由 `tests/helpers/comment-spans.ts` 的 TypeScript 词法器 oracle 判定。
   */
  keptCommentLines: number[]
}

/** 把 `source` 里的注释剥掉，保留字符串/正则字面量与换行（行号与原文一致）。 */
export function stripComments(source: string): string {
  return stripCommentsDetailed(source).text
}

/** 同 {@link stripComments}，另外回报状态机体检指标（见 {@link StripDiagnostics}）。 */
export function stripCommentsDetailed(source: string): StripDiagnostics {
  let out = ''
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  const stack: TemplateFrame[] = []
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    const next = source[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line'
        i++
        continue
      }
      if (c === '/' && next === '*') {
        state = 'block'
        i++
        continue
      }
      // 正则字面量整段原样保留 —— 里面的引号/斜杠都不是字符串或注释。
      if (c === '/' && regexAllowed(out)) {
        out += c
        let j = i + 1
        let inClass = false
        for (; j < source.length; j++) {
          const rc = source[j]!
          out += rc
          if (rc === '\\') {
            out += source[j + 1] ?? ''
            j++
            continue
          }
          if (rc === '[') inClass = true
          else if (rc === ']') inClass = false
          else if (rc === '/' && !inClass) break
          else if (rc === '\n') break // 正则不能跨行，防跑飞
        }
        // 吃掉 flags
        for (j++; j < source.length && /[a-z]/i.test(source[j]!); j++) out += source[j]!
        i = j - 1
        continue
      }
      if (c === "'") {
        state = 'single'
        out += c
        continue
      }
      if (c === '"') {
        state = 'double'
        out += c
        continue
      }
      if (c === '`') {
        stack.push({ kind: 'template' })
        state = 'template'
        out += c
        continue
      }
      // 在 `${…}` 表达式里：数花括号，深度归零才是插值结束（回到模板文本）。
      const top = stack[stack.length - 1]
      if (top !== undefined && top.kind === 'expr') {
        if (c === '{') {
          top.depth++
        } else if (c === '}') {
          if (top.depth === 0) {
            stack.pop()
            state = 'template'
          } else {
            top.depth--
          }
        }
      }
      out += c
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      }
      continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code'
        i++
      }
      // 换行保留，避免把两行粘成一行后产生假匹配、也避免行号漂移。
      else if (c === '\n') out += c
      continue
    }
    if (state === 'template') {
      // 模板文本里的转义：`\`` 不闭合、`\${` 不插值。
      if (c === '\\') {
        out += c + (next ?? '')
        i++
        continue
      }
      if (c === '`') {
        stack.pop()
        state = 'code'
        out += c
        continue
      }
      if (c === '$' && next === '{') {
        stack.push({ kind: 'expr', depth: 0 })
        state = 'code'
        out += c + next
        i++
        continue
      }
      out += c
      continue
    }
    // 字符串态：处理转义，遇到对应闭合引号回到 code。
    //
    // ⚠️ 模板串**也必须能闭合**。`llm-adapter.spec.ts` 里那份原实现写的是
    // `if (c === quote && state !== 'template')`，于是进模板串后再也回不到
    // code —— 源码里只要出现过一处反引号，**其后所有注释都不再被剥掉**。
    // 在 `src/index.ts` 上实测：该实现保留 221 666 字符，而正确实现只保留
    // 88 739 字符（差的那 13 万全是没剥掉的注释），一批 `not.toContain`
    // 断言因此假红。收敛时必须连这个 bug 一起修。
    const quote = state === 'single' ? "'" : '"'
    if (c === '\\') {
      out += c + (next ?? '')
      i++
      continue
    }
    if (c === quote) {
      state = 'code'
      out += c
      continue
    }
    out += c
  }
  // 体检指标：状态机的收尾状态才是「有没有脱轨」的证据；残留的 `//` 行只是线索。
  const keptCommentLines: number[] = []
  for (const [index, line] of out.split('\n').entries()) {
    if (line.trimStart().startsWith('//')) keptCommentLines.push(index + 1)
  }
  return { text: out, endState: state, stackDepth: stack.length, keptCommentLines }
}
