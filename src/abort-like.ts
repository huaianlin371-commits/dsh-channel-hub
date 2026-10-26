/**
 * 「调用方中止」类错误的**共享判据**（唯一权威）。
 *
 * ## 为什么独立成模块
 *
 * 这个判据原先住在 `aggregate-adapter.ts` 里，而它被 4 个与聚合毫无关系的
 * 消费者导入（`modelscope-adapter` / `index.ts` 的 isAbort 回调 /
 * `balance-cache` / `raccoon-adapter` 的同口径注释）。本 fork 移除聚合路线后，
 * 若继续留在原处，删聚合就会连带删掉一个全渠道共用的判据 —— 那正是「顺手清理」
 * 变成「静默拆护栏」的典型形态。
 *
 * ⇒ 判据与聚合解耦，放这里。**不要再在别处写第五份**（本仓库此前已有 4 份同义
 * 实现，是明确记录在案的缺陷）。
 *
 * ## 四条判据
 *
 * - `signal.aborted` —— 最权威（调用方确实取消了）；
 * - `name === 'AbortError'` —— `throwIfAborted` / `timers/promises` 的形态；
 * - `code === 'ABORTED'` —— 某些适配器上报失败时的机器码；
 * - 🔴 `message` 含 `aborted request` / `HTTP_499` / `HTTP 499` —— **上游网关的
 *   499 口径**（nginx「client closed request」＝ 连接在响应完成前被断开）。
 *   实测（2026-10-11，工单 `raccoon-499/01` 取证）：raccoon 网关把这类断开报成
 *   `provider: client has aborted request HTTP_499` 的 **error 帧**，三条旧判据
 *   全不命中 ⇒ 被归成「本轮运行失败」⇒ 消费者看到误导性的 provider 故障，
 *   而真相是「请求没跑完，重发即可」。
 *
 * ## 为什么中止与失败必须分开
 *
 * 中止时换候选会让用户在取消后仍继续跑（且最终抛出的可能是个误导性的上游错误）。
 *
 * @module src/abort-like.ts
 */

/**
 * 该错误是否是「调用方中止」类，而不是「这个候选坏了」类。
 *
 * @param error  捕获到的错误值（任意类型）。
 * @param signal 调用方的取消信号（可选）。给了就优先看 `aborted`。
 */
export function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  if (candidate.name === 'AbortError' || candidate.code === 'ABORTED') return true
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return /aborted request|HTTP_?499/i.test(message)
}
