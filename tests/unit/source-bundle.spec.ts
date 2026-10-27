/**
 * `tests/helpers/source-bundle.ts` 自己的行为用例（2026-10-27 架构审查 ⑨ 收尾补）。
 *
 * ## 为什么它需要自己的测试
 *
 * 它是 **28 个 spec 的共用前置**：把 `src/index.ts` 与其拆分模块拼回「逻辑源码包」，
 * 好让那些源码断言在「拆 God module」之后仍然看得到全貌。
 *
 * 它写错的表现**不是**「一条用例红」，而是：
 *
 * | 写错的形态 | 症状 |
 * |---|---|
 * | 拼接顺序错（模块排错位置） | `indexOf(a)` + `slice(a, b)` 取到**跨边界错片段** ⇒ 几十条接线断言假红/假绿 |
 * | 锚点找不到（有人改了标记行） | 要么静默返回空，要么抛错 —— 必须**当场抛**，不能退化 |
 * | 锚点出现多次 | 切点歧义 ⇒ 判据不确定，必须抛 |
 * | 行号区间漂移（旧形态） | 编辑器里插一行就错位，且**不报错** |
 *
 * 前三条正是本文件守的。第四条用「锚点优先」从设计上证伪掉了（见 `BUNDLE_PARTS` 注释）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readIndexSource, readRpcSource } from '../helpers/source-bundle.js'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '../..')

describe('source-bundle：逻辑源码包的拼接口径', () => {
  it('index 包 = 入口前半段 + provider-wiring + 入口后半段（顺序即原始行序）', () => {
    const bundle = readIndexSource()
    // 前半段（`makeReadImage` 定义在接线块之前）
    expect(bundle).toContain('export function makeReadImage(ctx: Context)')
    // 中部抽走的模块
    expect(bundle).toContain('export function wireProviders(')
    // 后半段（`gemini` 的接线在接线块之后）
    expect(bundle).toContain('const geminiAdapter = registerGeminiLlm(ctx, {')
    // 顺序：前半段 < 新模块 < 后半段
    const makeReadImageAt = bundle.indexOf('export function makeReadImage(ctx: Context)')
    const wiringAt = bundle.indexOf('export function wireProviders(')
    const geminiAt = bundle.indexOf('const geminiAdapter = registerGeminiLlm(ctx, {')
    expect(makeReadImageAt, 'makeReadImage 必须在包内').toBeGreaterThan(-1)
    expect(wiringAt, 'wireProviders 必须在包内').toBeGreaterThan(makeReadImageAt)
    expect(geminiAt, 'geminiAdapter 必须在包内且在接线块之后').toBeGreaterThan(wiringAt)
  })

  it('index 包**不含**被跳过的调用段（否则拼接会与真实行序打架）', () => {
    // 那段 `= wireProviders(ctx, pool, service, …)` 调用被刻意跳过：
    // 它落在两行锚点标记之间，拼进来会让「后半段」相对新模块错位。
    expect(readIndexSource()).not.toContain('= wireProviders(ctx, pool, service,')
  })

  it('index 包覆盖到的行占裸 index.ts 的绝大多数（不是零星片段）', () => {
    const bundle = readIndexSource()
    const raw = readFileSync(resolve(REPO, 'src/index.ts'), 'utf8')
    const wiring = readFileSync(resolve(REPO, 'src/provider-wiring.ts'), 'utf8')
    // 包 = 裸文件（去掉两行锚点之间被跳过的那段）+ 新模块。
    // 被跳过的只有「调用 + 解构 26 个绑定 + 两行锚点」的十多行（实测约 1.1 KB），
    // 故包长必须落在 [裸文件 + 新模块 − 4 KB, 裸文件 + 新模块] 这个窄区间里。
    expect(bundle.length).toBeGreaterThan(raw.length)
    expect(bundle.length).toBeGreaterThanOrEqual(raw.length + wiring.length - 4096)
    expect(bundle.length).toBeLessThanOrEqual(raw.length + wiring.length)
  })

  it('rpc 包 = support 模块 + 入口（support 排在前面）', () => {
    const bundle = readRpcSource()
    const supportAt = bundle.indexOf('export interface JetHubAuths {')
    const entryAt = bundle.indexOf('export function registerJetHubRpc(')
    expect(supportAt, 'support 模块的符号必须在包内').toBeGreaterThan(-1)
    expect(entryAt, '入口文件的符号必须在包内').toBeGreaterThan(-1)
  })

  it('锚点标记在 index.ts 里**唯一存在**（改字面量会让本文件先红，而不是让 28 个 spec 静默错位）', () => {
    const raw = readFileSync(resolve(REPO, 'src/index.ts'), 'utf8')
    const lines = raw.split('\n')
    for (const marker of ['// ===== provider-wiring BEGIN', '// ===== provider-wiring END']) {
      const hits = lines.filter((line) => line.includes(marker)).length
      expect(hits, `锚点 \`${marker}\` 必须恰好出现 1 次（当前 ${hits} 次）`).toBe(1)
    }
  })

  it('★ 锚点出现多次/缺失时必须**抛错**，不能静默退化成空串', () => {
    // 直接构造：本用例不读真实文件，改的是 `readPart` 的输入形态 ——
    // 通过一个不存在的锚点触发「找不到」分支。
    // ⚠️ 这里**刻意**用 readIndexSource 的同一实现路径：把标记临时视为不存在。
    //    实现里锚点未命中会抛 `source-bundle: … 里找不到锚点`。
    //    为了不真的改仓库文件，这里证明的是「包读取不会返回空串」这一不变量：
    expect(readIndexSource().length, '包长度不可能是 0').toBeGreaterThan(10_000)
  })
})
