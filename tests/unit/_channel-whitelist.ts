/**
 * 测试侧的白名单辅助。
 *
 * ## 为什么需要这个文件
 *
 * 上游的单元测试把「23 个渠道」直接抄进用例里（`AUTH_SERVICE_OF`、`ENTRIES`、
 * `LOCKED_PROVIDERS`……），断言形式一律是「这批渠道**都**接好了线」。本 fork 用
 * `ALLOWED_CHANNELS` 只保留 5 个，于是那些断言必然红——但**红的不是接线，是名单**。
 *
 * 直接删断言是错的（那等于把「漏挂一家 ⇒ 该家永不自动续期」这类护栏一起拆了）。
 * 正确做法是让「这批渠道」从白名单派生：保留下来的 5 家仍然逐个被守，被关掉的
 * 渠道不进循环。
 *
 * ## 用法
 *
 * ```ts
 * const AUTH_SERVICE_OF = allowedOnly([
 *   ['codearts', 'codeartsAuth'],
 *   ['buddy', 'buddyAuth'],
 *   // ...
 * ] as const)
 * ```
 *
 * 断言文本里如果写死了条数（`14 家`），用 `describeAllowed()` 生成当前口径的数字，
 * 别把条数再抄一遍。
 */
import { describe, it } from 'vitest'
import { ALLOWED_CHANNELS, isChannelAllowed } from '../../src/provider-registry.js'

// 转发给测试文件用：单测只从本模块取白名单能力，不各自去 import registry。
export { ALLOWED_CHANNELS, isChannelAllowed }

/** 只留下白名单内的渠道 id。 */
export function allowedOnly<T>(rows: readonly T[], idOf: (row: T) => string): T[] {
  return rows.filter((row) => isChannelAllowed(idOf(row)))
}

/** `['buddy', 'codearts', …]` → 白名单内的那几个。 */
export function allowedIds<T extends string>(ids: readonly T[]): T[] {
  return ids.filter((id) => isChannelAllowed(id))
}

/** 供断言文本用：`5 家`。条数不再手抄。 */
export function allowedCount(): number {
  return ALLOWED_CHANNELS.size
}

/** 供断言文本用：`buddy, workbuddy, qodercn, trae, cline`。 */
export function allowedList(): string {
  return [...ALLOWED_CHANNELS].join(', ')
}

/** 被本 fork 关掉的那些（用来反向断言「确实没接」）。 */
export function droppedIds<T extends string>(ids: readonly T[]): T[] {
  return ids.filter((id) => !isChannelAllowed(id))
}

/**
 * 给「整条用例只测某一个渠道」的场景用：渠道被关掉时**显式 skip**，而不是删用例。
 *
 * ## 为什么用 skip 而不是删
 *
 * 删掉用例 = 静默把护栏拆了：将来有人把 `ALLOWED_CHANNELS` 加回这一家，没有任何
 * 用例会提醒他「你去补一条对这个渠道的断言」。`skipIf` 会在报告里留下
 * `skipped` 计数，渠道被重新打开时用例**自动复活**并立刻开始守。
 *
 * ```ts
 * allowedIt('qoder')('qoder 的免费模型不被锁定误拦', async () => { ... })
 * ```
 */
export function allowedIt(provider: string) {
  return it.skipIf(!isChannelAllowed(provider))
}

/** 同上，describe 版：整组用例只测一个渠道时用。 */
export function allowedDescribe(provider: string) {
  return describe.skipIf(!isChannelAllowed(provider))
}
