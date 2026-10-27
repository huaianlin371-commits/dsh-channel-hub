/**
 * 源码包读取器 —— 让「拆 God module」不炸掉已有的源码断言。
 *
 * ## 为什么需要它
 *
 * 本仓库有 **50+ 个 spec 直接 `readFileSync('../../src/index.ts')` / `'../../src/jet-hub-rpc.ts'`**
 * 做源码级断言（结构存在性、调用顺序、禁止出现的写法）。这些断言在本仓历史上救过命：
 * 「接线只接一处」「白名单漏项」「字段声明了但没人用」都是靠它们当场抓到的。
 *
 * 但架构审查 ⑨ 要求把两个 God module 拆开（`src/index.ts` 5.5k 行、
 * `src/jet-hub-rpc.ts` 8.4k 行）。一旦把代码挪进兄弟模块，
 * `readFileSync('src/index.ts').includes('xxx')` 就会**假红**——
 * 代码还在、只是换了文件。
 *
 * ## 口径
 *
 * 断言要盯的是「**这个模块的整体**」，不是「这一个文件」。故这里把
 * 入口文件与其拆分出来的兄弟模块**拼成一个逻辑源码包**返回。
 *
 * ⚠️ 拼接顺序 = `BUNDLE_PARTS` 里列出的片段顺序，刻意按**原始行号先后**排列，
 * 这样 `indexOf(anchor)` + `slice(a, b)` 这类「取两个锚点之间的代码」的断言
 * 仍然拿得到合理的片段。新增拆分模块时必须同步把片段登记进 `BUNDLE_PARTS`，
 * 否则 spec 看不到它 —— 这条和「新增持久化键要补快照」是同一类纪律。
 *
 * ## 片段形态
 *
 * 一个片段要么是整文件 `'src/foo.ts'`，要么是带行区间的对象
 * `{ file: 'src/index.ts', from: 1, to: 1181 }`（1 基、闭区间，与编辑器行号一致）。
 * 区间片段只在「从文件**中部**抽走一段」时用：抽走之后 `index.ts` 的两端必须
 * 仍然按原顺序夹住新模块，否则跨边界的 `indexOf`+`slice` 会取到错片段。
 *
 * ⚠️ 拼接用 `\n` 连接，各文件已统一 LF；不要在调用侧再说 `.replace(/\r\n/g, '\n')`。
 */

import { readFileSync } from 'node:fs'

/** 仓库根（本文件位于 `tests/helpers/`）。 */
const REPO = new URL('../../', import.meta.url)

/**
 * 一个源码片段：整文件、某个文件的 1 基闭区间 `[from, to]`、
 * 或**按锚点标记**切开的片段（见 `beforeMarker` / `afterMarker`）。
 *
 * ⚠️ 优先用锚点形态：行号区间会在 `index.ts` 每次插/删行后漂移，而漂移的表现
 * 是「某几条源码断言悄悄看错片段」——**不报错、只是判据错位**。锚点形态
 * 把切点钉在被测文件自己的注释行上，编辑别处不会让它错位。
 */
export type BundlePart =
  | string
  | {
      readonly file: string
      readonly from?: number
      readonly to?: number
      /** 切在此行**之前**（该行本身不进入片段）。 */
      readonly beforeMarker?: string
      /** 从该行**之后**开始（该行本身不进入片段）。 */
      readonly afterMarker?: string
    }

/**
 * 逻辑源码包 → 组成片段（按**原始代码先后**排列）。
 *
 * 拆 module 时就往这里加片段，spec 一个字都不用改。
 * 新增/调整拆分模块时必须同步维护本表，否则源码断言会静默漏看新文件。
 */
const BUNDLE_PARTS: Readonly<Record<string, readonly BundlePart[]>> = {
  index: [
    // 架构审查 ⑨ 第二刀：`apply()` 里的 provider 接线块（原 :1182-3188，2007 行）
    // 搬进了 `src/provider-wiring.ts` 的 `wireProviders()`。原位置现在只剩
    // 「调用 + 解构 26 个绑定」的一段，由 `src/index.ts` 里那两行
    // `provider-wiring BEGIN / END` 标记夹住。
    //
    // 这里刻意切成「标记之前 → 新模块 → 标记之后」，**跳过**中间那段调用：
    // 拼出来的文本与原 `index.ts` 的行序一致（接线块还在它原来的位置、
    // `makeReadImage` 的定义仍在前半段、它之后的调用仍在后半段），跨边界的
    // `indexOf(anchor)` + `slice(a, b)` 断言才拿得到同样的片段。
    //
    // ⚠️ 用**锚点**而不是行号：2026-10-27 改这里时吃过一次亏 —— 行号写死之后
    //    上游随手插一行注释就会让它错位，而错位的表现是「断言静默看错片段」。
    { file: 'src/index.ts', beforeMarker: '// ===== provider-wiring BEGIN' },
    'src/provider-wiring.ts',
    { file: 'src/index.ts', afterMarker: '// ===== provider-wiring END' },
  ],
  // ⚠️ 顺序 = 原始行号：架构审查 ⑨ 第一刀把 `jet-hub-rpc.ts` 前 1856 行的工具层
  // 搬进了 `jet-hub-rpc-support.ts`，所以它必须排在前面，否则
  // `indexOf('export interface JetHubAuths {')` 之类的定位虽然还找得到，
  // `slice` 出来的相对片段却会跨错边界。
  rpc: ['src/jet-hub-rpc-support.ts', 'src/jet-hub-rpc.ts'],
}

/** 读一个片段（整文件 / 行区间 / 锚点切分）。 */
function readPart(part: BundlePart): string {
  if (typeof part === 'string') return readFileSync(new URL(part, REPO), 'utf8')
  const text = readFileSync(new URL(part.file, REPO), 'utf8')
  const lines = text.split('\n')

  const anchor = part.beforeMarker ?? part.afterMarker
  if (anchor !== undefined) {
    const hits = lines.reduce<number[]>((acc, line, i) => {
      if (line.includes(anchor)) acc.push(i)
      return acc
    }, [])
    if (hits.length === 0) {
      throw new Error(`source-bundle: ${part.file} 里找不到锚点 \`${anchor}\``)
    }
    if (hits.length > 1) {
      throw new Error(
        `source-bundle: ${part.file} 里锚点 \`${anchor}\` 出现 ${hits.length} 次（必须唯一）`,
      )
    }
    // `beforeMarker`：切在该行之前；`afterMarker`：从该行的下一行开始。
    const cut = part.beforeMarker !== undefined ? hits[0]! : hits[0]! + 1
    return (part.beforeMarker !== undefined ? lines.slice(0, cut) : lines.slice(cut)).join('\n')
  }

  const from = Math.max(1, part.from ?? 1)
  const to = part.to === undefined ? lines.length : Math.min(lines.length, part.to)
  if (from > to) {
    throw new Error(`source-bundle: ${part.file} 的区间 ${from}-${to} 为空（文件共 ${lines.length} 行）`)
  }
  return lines.slice(from - 1, to).join('\n')
}

/** 读某个逻辑源码包并拼接。 */
function readBundle(name: 'index' | 'rpc'): string {
  const parts = BUNDLE_PARTS[name]
  if (!parts || parts.length === 0) throw new Error(`source-bundle: 未登记的源码包 ${name}`)
  return parts.map(readPart).join('\n')
}

/** `src/index.ts` 的逻辑源码包（入口 + 中部抽走的接线模块）。 */
export function readIndexSource(): string {
  return readBundle('index')
}

/** `src/jet-hub-rpc.ts` 的逻辑源码包（入口 + 拆出去的工具层）。 */
export function readRpcSource(): string {
  return readBundle('rpc')
}
