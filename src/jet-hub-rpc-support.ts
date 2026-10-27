/**
 * `jet-hub-rpc` 的**纯工具层**：与端点分派无关的常量、凭据解析、批量采集、
 * 目录读取 —— 从 `jet-hub-rpc.ts` 里整段搬出来的（架构审查 ⑨ 拆 God module）。
 *
 * ## 为什么拆到这里
 *
 * 搬走之前 `jet-hub-rpc.ts` 是 8425 行 / 342 KB：前面 1856 行是**与 HTTP 无关**的
 * 工具函数，后面 6200 行才是 `registerJetHubEndpoints` 的超大 `switch`。读这个文件
 * 的人 80% 的时间花在找「到底从哪一行开始才是分派」。拆完之后：
 *
 * - 本文件 = 可独立理解、可单独 import 的工具层（零 `ctx` / 零 HTTP）；
 * - `jet-hub-rpc.ts` = 端点注册 + 分派 + 各 case 实现。
 *
 * ## 契约：**不要从本文件 import 任何 `jet-hub-rpc.ts` 的东西**
 *
 * 本模块是叶子层。反向依赖（`jet-hub-rpc.ts` → 本文件）是单向的；一旦本文件
 * 反过来 import 它，就形成循环依赖，ESM 下会在装载顺序上咬人。
 *
 * `DEFAULT_ROUND_BUDGET_MS` 与 `OfficeAceAuth` 两条声明原本**夹在 `jet-hub-rpc.ts`
 * 的 import 语句中间**（历史上的补丁位），被本模块消费，所以一并搬到这里，
 * 再由 `jet-hub-rpc.ts` import 回去。
 *
 * ## ⚠️ 新增/搬动声明时的两条纪律
 *
 * 1. 这里的名字若被 `jet-hub-rpc.ts` 继续使用，必须同时出现在它的 re-export 清单里
 *    （`tests/unit/source-bundle.ts` 与外部 import 者都靠那个清单）。
 * 2. 若把**更多**代码搬到本文件，记得把本文件登记进 `tests/helpers/source-bundle.ts`
 *    的 `BUNDLE_PARTS.rpc`，且顺序保持在 `src/jet-hub-rpc.ts` **之前**。
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from './account-pool.js'
import type { AutoBadgeState } from './auto-badge.js'
import { collectGatewayEffortViews, collectGatewayModels, toGatewayModelIds } from './openai-gateway/models.js'
import type { GatewayModelSource } from './openai-gateway/models.js'
import type { CodeArtsAuth } from './service.js'
import type { CodeArtsCredential, ProviderAccountEntry, RpcCreditsStatusResponse, RpcCreditsClaimAllResponse, RpcBuddyGrowthAccountResult, RpcCreditsClaimSummary, RpcCreditsBalanceExtra, RpcCreditsBalancesResponse, RpcGatewayModel, CatalogHealth } from './types.js'
import type { BuddyAuth } from './buddy-auth.js'
import type { LobsteraiAuth } from './lobsterai-auth.js'
import type { QoderAuth } from './qoder-auth.js'
import type { TraeAuth } from './trae-auth.js'
import type { ClineAuth } from './cline-auth.js'
import { WIRED_EXPIRY_PROVIDERS } from './aggregate-expiry.js'
import type { LoomyAuth } from './loomy-auth.js'
import type { RaccoonAuth } from './raccoon-auth.js'
import type { ZcodeAuth } from './zcode-auth.js'
import { ZCODE_LOGIN_PROVIDER } from './zcode-login.js'
import type { ZcodeLoginProvider } from './zcode-login.js'
import type { RaccoonCredential } from './raccoon.js'
import type { MinimaxAuth } from './minimax-auth.js'
import type { GeminiAuth } from './gemini-auth.js'
import type { AccioAuth } from './accio-auth.js'
import type { AutoclawAuth } from './autoclaw-auth.js'
import { AUTOCLAW_INTL } from './autoclaw-product.js'
import type { ModelscopeAuth } from './modelscope-auth.js'
import { ASTUDIO } from './astudio-product.js'
import type { AstudioAuth } from './astudio-auth.js'
import type { CodelyAuth } from './codely-auth-service.js'
import { CODERLY } from './codely-product.js'
import { PROVIDER_REGISTRY } from './provider-registry.js'
import { creditsOf } from './provider-credits.js'
import type { ProviderCredits } from './provider-runtime.js'
import { TRAE } from './trae-product.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { QoderCredential } from './qoder.js'
import type { TraeCredential } from './trae.js'
import type { ClineCredential } from './cline.js'
import type { BuddyCredential } from './buddy.js'
import { claimDailyCheckin, claimUnitOf, fetchCheckinStatus, fetchCreditBalance } from './credits.js'
import type { CheckinStatus, ClaimOutcome, CreditBalance } from './credits.js'
import type { BuddyProduct } from './product.js'
import { deadModelIdsFor } from './dead-model-store.js'

import type * as OfficeAceAuthModule from './officeace-auth.js'

/** 以模块命名空间为类型（`startLogin` / `pollLoginCode` / `fetchSubscriptionSummary` 等纯函数）。 */
export type OfficeAceAuth = typeof OfficeAceAuthModule

/* ---------------------------------------------------------------- */
/* 与 `jet-hub-rpc.ts` 共享的量（原本夹在它的 import 之间）               */
/* ---------------------------------------------------------------- */

/**
 * 整轮成长任务的时间预算缺省值（毫秒）。
 *
 * 上界由**账号数 × 逐账号预算**决定（后者缺省 10 分钟），账号多时线性增长。
 * 30 分钟约覆盖 3 个账号从容跑完；超出即如实停住并报出未跑的账号，而不是撞上
 * 宿主 RPC 的超时（该上界由 dsh 侧决定，本插件不可见也不可控）。
 */
export const DEFAULT_ROUND_BUDGET_MS = 30 * 60 * 1000

/** 大肥鱼饭碗 RPC API 路径 */
export const JET_HUB_API_PATH = '/api/jet-hub'
/**
 * 内部 captcha **载体页**的 GET 路径（与 GUI 同源，故 `<webview>` 能导航过来）。
 *
 * ⚠ 它挂在 `/api/` 前缀下，因而不是「随便一个静态页」：DSH 的 `/api` 路由会先过
 *   Connection 的 Host/Origin 栏与**浏览器会话认证**（`dsh-client-connection` 的
 *   `admit()` ⇒ 未认证回 401）。桌面版的 guest 与 GUI 是否同 partition、
 *   因而带得上那份会话 cookie，属 Task 5 的**实测项**，不在这里放宽。
 */
export const CAPTCHA_CARRIER_PATH = '/api/jet-hub/captcha-carrier'
/** Gateway RPC 端点名（connection.rpc.call 的 endpoint 参数） */
export const JET_HUB_ENDPOINT = 'jet-hub'

/** 生成 8 字符随机短 ID（小写 hex） */
export function shortId(): string {
  const buf = new Uint8Array(4)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * OfficeAce 登录中间态的有效期（毫秒）—— **判据的唯一实现处**。
 *
 * ## 为什么必须有（Gitee issue IKM741 的 A 档：登录中止留幽灵占位账号）
 *
 * `account.create` **先** `pool.addAccount` 登记占位条目、**再**返回 `loginUrl`，
 * 此后由 `login.poll` 轮询取 code。用户**打开授权页但没完成授权就关掉**时
 * （issue 原话「好像是没回调 callback」），云侧永远不会给出 code ⇒ 占位条目
 * **永久残留**成一张「凭据未配置」的幽灵卡片，而它没有任何入口会被清理
 * （issue 原话「还要手动删一次」）。
 *
 * ⚠️ **不能判成「失败」来清理**：「用户还没授权完」与「正在轮询」必须同形 ——
 * 判成失败会**删掉正在进行的正常登录**。故判据只能是**时间**。
 *
 * 客户端自己的轮询上限是 5 分钟（`plugin-src/client/jet-hub.js` 的
 * `deadline = Date.now() + 300000`），超时后它停表并关窗 —— 那之后这个中间态
 * 在结构上已经**不可能**再拿到 code。这里取 **4 倍余量**（20 分钟），让
 * 「慢网络 / 用户在多个窗口间切换」都还有救，而残留最多存活 20 分钟。
 *
 * `DSH_OFFICEACE_PENDING_TTL_MS` 可覆盖（**测试与 e2e 用**：判据必须是
 * 「确定时刻」可驱动的，见 `healExpiredAccounts` 的 `now` 注入点那条教训）。
 * ⚠️ 非法值（NaN / ≤0）回落默认值：`parseInt(x) || default` 那种写法会把
 * **显式传 0** 也吃掉，而 0 在这里是合法且有意义的值（「立即收口」）。
 */
export function officeacePendingTtlMs(): number {
  const raw = process.env.DSH_OFFICEACE_PENDING_TTL_MS
  if (raw === undefined || raw.trim().length === 0) return OFFICEACE_PENDING_TTL_MS_DEFAULT
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 0) return OFFICEACE_PENDING_TTL_MS_DEFAULT
  return parsed
}

/** {@link officeacePendingTtlMs} 的默认值（20 分钟 = 客户端轮询上限的 4 倍）。 */
export const OFFICEACE_PENDING_TTL_MS_DEFAULT = 20 * 60_000

/**
 * 判「这份 OfficeAce 登录中间态是否已被用户中止」—— **判据的唯一实现处**。
 *
 * 抽成纯函数（而不是内联在收口循环里）的理由与 `officeacePendingTtlMs` 同源：
 * 边界（恰好 TTL、TTL 前 1ms）必须能被**确定地**测到 —— 内联时判据隐含在
 * 一次 `Date.now()` 调用里，用例只能靠跨毫秒的运气命中（本仓库已实测过
 * 「20 次只有 10 次变红」的同型事故）。
 *
 * ⚠️ **中间态缺失 ⇒ 判定为「已中止」**（`pending === undefined` 返回 true）：
 * 那种形态是「宿主重启过，中间态（内存 Map）丢了，而池里的占位条目还在盘上」
 * —— 它同样拿不到 code（state 已随进程消失），属于**必须收口**的残留。
 * ⚠️ 但收口**仍要过凭据那道闸**（见 `sweepAbandonedOfficeAceLogins`）：重启后
 * 若凭据早已落库，条目必须保留。
 *
 * ## ⚠️⚠️ 「在途」是**显式状态**，不是时间推断（2026-10-17 红队 P2 + P4 两轮打穿）
 *
 * 判据演化（每一步都由可复现探针推动）：
 *
 * | 版本 | 判据 | 红队打穿的形态 |
 * |---|---|---|
 * | 初版 | `now - pending.at > TTL`，且落库**前**就删 pending | **P2**：落库中任何 `account.list` 都删号（不需要 TTL 到期） |
 * | 二版 | 把 `delete` 挪到落库**之后** | **P4**：落库**耗时 > TTL** 时，`pending` 虽在仍判「已中止」⇒ 同样删号 |
 * | 三版（本版） | **`settling` 显式在途标记**：为真时**无条件**返回 false | —— |
 *
 * ⚠️ 我一度想用「`login.poll` 每次刷新 `at`」这个更省的替代（红队也提了）：
 *    它对**真机**有效（客户端每 1 秒轮询），但**结构上仍不严密** ——
 *    只要 `account.list` 在两次轮询之间到达、且 `at` 恰好已过 TTL，判据仍会误判。
 *    红队探针（只调 `account.list`、不调 `login.poll`）正是这样打穿它的。
 *    ⇒ 「在途」必须是**离散可分**的状态，**不能靠任何时间判据近似**。
 *
 * @param pending - 该账号的中间态（`undefined` = 没有 / 已随重启丢失）。
 * @param nowMs - 「现在」的毫秒时刻（**入参化**，不在这里读时钟）。
 */
export function isAbandonedOfficeAceLogin(
  pending: { at: number; settling?: boolean } | undefined,
  nowMs: number,
): boolean {
  if (pending === undefined) return true
  /**
   * ⚠️⚠️ **落库进行中 ⇒ 绝不判「已中止」**（与 TTL 无关）。
   *
   * 这一格是「不可逆删除必须建立在**确证**上」的最后一道：该账号此刻正把凭据
   * 写进库，删掉它就是**销毁用户刚完成授权的登录**（`removeAccount` 连带
   * `credentials.unset`，不可逆且用户零提示）。
   * ⚠️ 判据放在 TTL 之前 —— 顺序即语义：**在途优先于超时**。
   */
  if (pending.settling === true) return false
  // ⚠️ 用 `>`（严格大于）：恰好等于 TTL 时**仍算进行中** —— 边界方向与
  //    `healExpiredAccounts` 的 `now() >= deadlineAt`（反向）刻意不同，
  //    因为这里的「收口」是不可逆的删除，宁可多留一轮。
  return nowMs - pending.at > officeacePendingTtlMs()
}

/**
 * ZCode 登录渠道的白名单归一。
 *
 * ## 为什么要有这道
 *
 * `account.create` 的载荷来自**客户端自报**（RPC 入口没有 schema 校验），
 * 而 `ZcodeLoginProvider` 只是个 TypeScript 联合类型 —— 运行时任何字符串都能进来。
 * 原先只写 `req.zcodeProvider ?? 'bigmodel'`：缺省兜底是对的，但**没有校验**，
 * 传入 `zhiPu` / `ZAI`（大小写不同）这类未登记值会被原样送进
 * `startZcodeLogin` → 打到一个不存在的授权端点，表现为
 * 「授权页打不开」或「轮询到超时」这类极难定位的失败。
 *
 * ## 为什么**回落**而不是报错
 *
 * 回落方向与既有的 `?? 'bigmodel'` 兜底一致：老客户端、新客户端、
 * 手改过载荷的用户都还能登录（只是用缺省渠道）。且前端只会下发下拉框里的
 * 两个值，正常路径永远走不到这条分支 —— 它是**兜底**不是**主路径**。
 * 真正非法的输入会留一条 `console.warn`（与本文件其余告警同一惯例），
 * 便于事后发现是哪个客户端在发怪值。
 *
 * @param raw 客户端自报的渠道（可能未登记）
 * @returns 可安全交给 `zcode.startLogin` 的渠道
 */
export function normalizeZcodeLoginProvider(raw: string | undefined): ZcodeLoginProvider {
  if (raw === 'zai') return 'zai'
  if (raw !== ZCODE_LOGIN_PROVIDER) {
    // ⚠ 只在**非缺省**时记 warn：`undefined` 是绝大多数调用方的形态（老客户端不传），
    //   对它刷日志等于每建一个账号多一行噪音，会把真正的异常埋掉。
    if (raw !== undefined) {
      console.warn(
        `[jet-hub] 未登记的 zcode 登录渠道 ${JSON.stringify(raw)}，已回落到 ${ZCODE_LOGIN_PROVIDER}`,
      )
    }
  }
  return ZCODE_LOGIN_PROVIDER
}

/** 解析 Buddy 凭据 JSON；解析失败返回 undefined。 */
export function parseBuddyCredential(raw: string): BuddyCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as BuddyCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 CodeArts 凭据 JSON；解析失败返回 undefined。 */
export function parseCodeArtsCredential(raw: string): CodeArtsCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as CodeArtsCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_key_id === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 LobsterAI 凭据 JSON；解析失败返回 undefined。 */
export function parseLobsteraiCredential(raw: string): LobsteraiCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as LobsteraiCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 Qoder 凭据 JSON；解析失败返回 undefined。 */
export function parseQoderCredential(raw: string): QoderCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as QoderCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 TRAE 凭据 JSON；解析失败返回 undefined。 */
export function parseTraeCredential(raw: string): TraeCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as TraeCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 Cline 凭据 JSON；解析失败返回 undefined。 */
export function parseClineCredential(raw: string): ClineCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as ClineCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 构造 Raccoon 账号的**展示名**：`RaccoonAva (1100)`。
 *
 * ## 为什么要追加手机号尾号
 *
 * 服务端的 `name` 是**自动生成的默认名**（实测本机账号为 `RaccoonAva`，
 * 即「Raccoon」+ 随机串）。实证：
 *
 * - `GET /user_info` 的 `data.name = "RaccoonAva"`；
 * - JWT payload 里同样带 `name: "RaccoonAva"`（官方客户端就是读这个：
 *   `M = () => { ... userName: t.name, id: t.sid }`）；
 * - `wechat_bindings` 只有 `[{id, bound_at}]` —— **没有微信昵称/头像**。
 *   微信扫码走 `snsapi_login`（只给 openid），要昵称需额外申请
 *   `snsapi_userinfo`，这里显然没申请。
 *
 * 所以「显示 `RaccoonAva`」本身与官方一致、**不是取错字段**；但它是默认名，
 * 注册第二个账号时服务端很可能又给一个相近的名字 → 多账号重名、无法区分。
 *
 * 修法参考 Loomy（`Loomy 2222`）：这边有真实名字可用，故**保留原名再挂尾号**，
 * 兼顾「看得出服务端原名字」与「多账号可区分」。
 *
 * 退化顺序：昵称 + 手机号尾号 → 昵称 + 用户 id → 昵称 → 账号 id。
 * ⚠️ 手机号取**后 4 位**（够区分且不完整暴露号码）。
 */
export function buildRaccoonNickname(
  credential: Pick<RaccoonCredential, 'nickname' | 'phone' | 'user_id'>,
  fallbackId: string,
): string {
  const nickname = typeof credential.nickname === 'string' ? credential.nickname.trim() : ''
  const phone = typeof credential.phone === 'string' ? credential.phone.trim() : ''
  const userId = typeof credential.user_id === 'string' ? credential.user_id.trim() : ''

  // 消歧后缀：优先手机号尾号（更利于用户辨认是哪个号），否则用户 id
  const suffix = phone.length >= 4
    ? phone.slice(-4)
    : userId.length > 0 ? userId : ''

  if (nickname.length > 0) {
    // 已有该后缀时不重复追加（例如服务端名字里本就带手机号尾号）
    return suffix.length > 0 && !nickname.includes(suffix) ? `${nickname} (${suffix})` : nickname
  }
  if (suffix.length > 0) return `Raccoon ${suffix}`
  return fallbackId
}

/**
 * 支持「锁定永久积分」的 provider 白名单。
 *
 * ⚠️ **必须与前端 `plugin-src/client/jet-hub.js` 的 `supportsPermanentLock` 一致**：
 * 前端拿它决定要不要渲染按钮、要不要发读取请求；后端拿它拒绝越权写入。
 * 两边不一致的后果是「按钮出现但点了报错」或「功能存在却点不出来」。
 *
 * 登记条件：**余额响应里能拿到逐包的到期时间**（归一化到 `deductionEndTime`），
 * 从而分出「快到期」与「不会马上作废」两桶。判据见
 * `buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry` —— 它只读通用的
 * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
 *
 * | provider | 分桶依据 |
 * |---|---|
 * | Loomy | 服务端直接给 `dailyBalance`（当日到期）与 `balance`（永久）两个命名池 |
 * | CodeBuddy / WorkBuddy | 资源包列表的 `DeductionEndTime` 距今是否满窗口天数 |
 * | TRAE（字节） | 资源包列表的**条目级** `expire_time`（秒级 Unix 时间戳） |
 * | LobsterAI（有道） | 资源包列表的 `expiresAt`（ISO 8601） |
 *
 * ⚠️ TRAE / LobsterAI **不区分「每日额度」与「永久积分」两个命名池**，但同样能按
 * 到期时间分桶 —— 对锁定功能而言，判据只需「会不会马上作废」，与池的名字无关。
 * 拿不到到期时间的包归入**永久桶**（保守方向：宁可锁定时少用一个号，
 * 也不要把长期积分误当快到期烧掉，见 `splitBuddyCreditsByExpiry` 注释）。
 *
 * 仍未登记的渠道（CodeArts / Qoder / Cline / Raccoon / Minimax / ZCode / Gemini /
 * OpenCode）：余额响应里没有逐包到期时间，或根本没有资源包列表 ——
 * 分不出两桶，登记进来只会多一个无效开关。
 *
 * ## ⚠️ 2026-10-08 起从 `PROVIDER_REGISTRY` 派生
 *
 * 原先这是一份手抄 `Set`，而客户端 `supportsPermanentLock` 读的是 registry 的
 * `permanentLock` 字段 ⇒ **两处必须一致**（不一致会出现「按钮渲染出来了，
 * 点了却报 bad-request」）。现在两侧同出一个字段，不再可能漂移。
 * 上面那张「分桶依据」表已随值迁移到 registry 里各条的注释。
 *
 * ⚠️ **本常量是模块级、但这里安全**：它只读 `PROVIDER_REGISTRY`（Task 1 的
 * **静态数据**），**不读 runtime 注册表** —— 后者要到 `apply()` 才填充，
 * 模块级求值会得到空集（`WIRED_EXPIRY_PROVIDERS` 那条注释记的正是这个陷阱，
 * 但那里是**刻意**保持常量的，理由见 `aggregate-expiry.ts`）。
 * 判据是「读的是不是静态数据」，不是「是不是模块级常量」。
 */
export const PERMANENT_LOCK_PROVIDERS: ReadonlySet<string> = new Set(
  PROVIDER_REGISTRY.filter((d) => d.permanentLock === true).map((d) => d.id),
)

/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 *
 * ★ **按单位分开累加**（2026-10-04，真实缺陷）：`totalCredit` 这个标量会把
 * 不同量纲加在一起（ZCode 的 1 亿 token + 100 积分 = `100000100`），单位信息
 * 一旦在这一层丢掉，下游无论怎么写文案都只能标一个「积分」。故同时产出
 * `totalByUnit`，消费方一律用它（见 `RpcCreditsClaimSummary.totalByUnit`）。
 *
 * ⚠️ `totalCredit` **保留原语义**（跨单位求和），只为不破坏既有契约；
 * **不要**在展示路径上用它 —— 那正是本缺陷的成因。
 */
export function computeClaimSummary(outcomes: readonly ClaimOutcome[]): RpcCreditsClaimSummary {
  const summary: RpcCreditsClaimSummary = {
    claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0,
    totalByUnit: { token: 0, credit: 0 },
  }
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'claimed':
        summary.claimed += 1
        summary.totalCredit += outcome.credit
        // ⚠️ 单位缺省按 `credit`（与 `ClaimOutcome.unit` 的声明一致）——
        // 只有 ZCode 显式传 `'token'`，其余 11 个渠道逐字不变。
        summary.totalByUnit[claimUnitOf(outcome.unit)] += outcome.credit
        // ⚠️ 只有**覆盖今天**的领取才算「今天已处理」。`coversToday:false` 是
        // 渠道自己标的（当前是 Qoder 刷新前那一轮），见 `credits.ts` 的字段说明。
        if (outcome.coversToday !== false) summary.coversToday += 1
        break
      case 'already-claimed':
        summary.alreadyClaimed += 1
        if (outcome.coversToday !== false) summary.coversToday += 1
        break
      case 'inactive':
        summary.inactive += 1
        break
      case 'failed':
        summary.failed += 1
        break
      default: {
        // 编译期穷尽性检查：ClaimOutcome 未来新增 kind 时此处会报错，
        // 迫使作者显式决定它该计入哪一栏，而不是被静默漏计。
        const exhaustive: never = outcome
        void exhaustive
        // 运行期兜底：类型声明与运行时不符（未知 kind）时按 failed 计入，
        // 宁可多报一个失败，也不让结果凭空消失。
        summary.failed += 1
        break
      }
    }
  }
  return summary
}

/**
 * 积分端点的可注入依赖。
 *
 * 抽出这一层是为了让「逐账号处理」能脱离 `ctx.connection.fetch` 注册流程
 * 单独单测：端点内不做任何业务判断，只负责取账号列表并转交下面的纯函数。
 *
 * **对凭据/产品类型做泛型化**（而非写死 Buddy 系类型）：LobsterAI 的协议
 * 完全不同（无签名、三步签到、身份字段是 keyfrom），但「逐账号顺序执行、
 * 单个失败不中断、凭据解析在 try 之内」这套编排逻辑是**通用**的。
 * 泛型化让 `collect*` 三兄弟只写一遍，两套协议各自注入自己的下钻函数。
 * 默认类型参数保持 Buddy 系，故既有调用点与测试一行都不用改。
 */
export interface CreditsEndpointDeps<
  TCredential = BuddyCredential,
  TProduct = BuddyProduct,
> {
  /**
   * 解析凭据引用。
   * 按设计该接口**不可信**（凭据可能已被外部删除、provider 后端异常），
   * 实现允许抛错，调用方必须把异常算在单个账号头上。
   */
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  /** 查询签到状态；默认使用真实的 fetchCheckinStatus。 */
  fetchStatus?: (credential: TCredential, product: TProduct) => Promise<CheckinStatus | null>
  /**
   * `collectCreditsStatus` 的**并发度**；默认 3。
   *
   * 只影响 `credits.status` 这一趟逐账号查询（见该函数的长注释）。
   * `1` = 完全串行（升级前语义）；测试与将来调参用。
   */
  concurrency?: number
  /** 执行签到领取；默认使用真实的 claimDailyCheckin。 */
  claim?: (credential: TCredential, product: TProduct, entry: ProviderAccountEntry) => Promise<ClaimOutcome>
  /**
   * 领取之后的下钻钩子，返回值原样带进 {@link RpcCreditsClaimAllResponse} 的
   * `growth` 字段。
   *
   * 存在的理由：成长中心任务与签到**共用同一趟逐账号循环**才能避免把凭据解析
   * 做两遍（凭据可能被外部删除，解析两次会得到两次不同的失败路径）。而它又
   * **不能**混进 `claim` 本身 —— `claim` 的返回类型是 `ClaimOutcome`，装不下
   * 22 项任务的逐项判据。
   *
   * ⚠️ **只有 buddy 注入**（`workbuddy` 后端没有成长中心，见 `src/product.ts`
   * 的 `WORKBUDDY` 注释）；其余 provider 不传，行为逐字不变。
   *
   * ⚠️ 2026-10-08（Task 4）：**「哪家有成长中心」不再由本文件的手抄集合判定**
   *（原 `GROWTH_CAPABLE_PROVIDERS` 已删除），改由「该家是否提供
   * `ProviderCredits.afterClaim`」回答。本钩子仍是**同一个骨架接缝**，
   * 只是调用侧的门控换成了能力表。
   */
  afterClaim?: (
    credential: TCredential,
    product: TProduct,
    entry: ProviderAccountEntry,
    outcome: ClaimOutcome,
    /**
     * 整轮共享的截止时刻（`Date.now()` 口径），或 `undefined` 表示不限时。
     *
     * ⚠️ 逐账号预算是**每账号**上限，N 个账号会线性累加；宿主 RPC 的超时上界
     * 由 dsh 侧决定，本插件不可见也不可控。故另给一个整轮预算，让「账号很多」
     * 时也能**如实停住并报出哪些账号没跑**，而不是撞上宿主超时后前端只看到一个
     * 无来由的失败。
     */
    roundDeadlineAt: number | undefined,
  ) => Promise<RpcBuddyGrowthAccountResult | undefined>
  /**
   * 签到收尾的**附加提示**（可选；对 `claimed` 与 `already-claimed` **都会跑**）。
   *
   * ## 为什么需要它（2026-10-20 用户报障，真机截图）
   *
   * TRAE 的「1024 打卡抽奖」应该在**点签到按钮**时触发。第一版把抽奖挂在
   * `claimTraeDailyCheckin` 内部 ⇒ **几乎永不触发**：本家 `precheckStatus: true`，
   * `credits.claimAll` 会先查状态，今天已签到就直接回 `already-claimed`、
   * **根本不调 `claim`**（见上面 `precheck` 那段）。而「已签到」恰恰是最该抽奖的
   * 时机（签到后才解锁抽奖）⇒ 用户实测 4 个账号全显示「今天已签到」、
   * 一条抽奖信息都没有。
   *
   * ## 契约
   *
   * - 返回**字符串** ⇒ 追加到该账号的 `outcome.message`（客户端已经渲染这一行）；
   * - 返回 `undefined` ⇒ 什么都不加（**不该抽的情形必须回 undefined**，
   *   报「今天本来就不该抽」只会制造噪声）；
   * - **永不抛**：抽奖是不可逆写操作且会因「今日已参与 / 窗口外 / 无资格」失败，
   *   那些都**不是**签到失败（本仓库有两轮「登录成功却因记账失败被报成失败」事故史）。
   *
   * ⚠️ 只有 trae 注入；其余 provider 不传 ⇒ 行为逐字不变。
   */
  afterClaimNote?: (
    credential: TCredential,
    product: TProduct,
    entry: ProviderAccountEntry,
    outcome: ClaimOutcome,
  ) => Promise<string | undefined>
  /** 查询积分余额；默认使用真实的 fetchCreditBalance。 */
  fetchBalance?: (credential: TCredential, product: TProduct) => Promise<CreditBalance | null>
  /**
   * 余额查询的**带原因**版本（优先于 {@link fetchBalance}）。
   *
   * 为什么需要它：`fetchBalance` 只用 `null` 表达「查不到」，调用方统一回
   * 「余额查询失败」。但 CodeArts 还有第三种情形 —— **非积分计费账户**
   * （Token 计费）：它不是故障，如实显示「余额查询失败」会把用户引向错误的
   * 排查方向。该钩子让实现能带回精确文案，同时仍复用本函数的逐账号编排
   * （顺序执行、单账号失败不中断、凭据解析在 try 之内）。
   */
  fetchBalanceDetailed?: (
    credential: TCredential,
    product: TProduct,
    accountId?: string,
  ) => Promise<{ balance: CreditBalance | null; error?: string; extra?: RpcCreditsBalanceExtra }>
  /**
   * 整轮（全部账号）的时间预算（毫秒）。缺省 30 分钟。
   *
   * 与逐账号的 `budgetMs`（`afterClaim` 内透传）是**两个独立闸门**：前者管
   * 「账号很多」，后者管「单个账号卡住」。传0 或负数表示不限时。
   */
  roundBudgetMs?: number
  /** 单账号异常时的告警出口（不参与控制流）。 */
  warn?: (message: string) => void
  /**
   * **共享余额读数缓存**的回写出口（2026-10-15，规格 §5.7）。
   *
   * ## ⚠️ 为什么是「回写」而不是「改读」（本端点的响应形状约束）
   *
   * 本端点的响应是 `{ balance, error?, extra? }`，比折算路径要的 `CreditBalance`
   * **多两个字段**（Gemini 的 `extra` 来自另一个端点）⇒ 让本端点「读」缓存会**丢字段**。
   * ⇒ 本端点继续用自己的取数（**响应逐字节不变**），但把拿到的 `balance`
   * **写回**缓存 —— 于是聚合折算能命中面板刚查过的那一条。
   *
   * ⚠️ 省略时本端点行为与升级前**逐字节相同**（未接线 = 无回写）。
   */
  writeBalance?: (accountId: string, balance: CreditBalance) => void
  /**
   * ★ **共享余额读数缓存**的**读**出口（2026-10-16，issue IKMCOO 缺陷 1 + 用户要求）。
   *
   * ## 为什么需要它（与上面 `writeBalance` 互补）
   *
   * `writeBalance` 只让**别的消费者**命中本端点的读数；本端点自己**每次调用
   * 仍逐账号打上游**。而本端点有**多个调用方**（面板渲染、用量徽标的分钟级
   * 轮询——见 `usage.badge` 内部直接调 `credits.balances`），于是同一个账号在
   * 一分钟里被查 N 次：上游抖动时一失败就整批拖住，用户看到「面板加载很久」。
   *
   * ⇒ 本钩子让端点**先吃共享读数**（含陈旧兼顶），命中即零网络请求。
   *
   * ## ⚠️ 形状约束与 `writeBalance` 同源（端点响应有 `extra` 等额外字段）
   *
   * 本钩子返回的是**折叠后的** `CreditBalance`（缓存里那份），**不含** `extra`
   * ⇒ 命中时**不得**同时回传 `extra`，否则那是编造。
   *
   * @param accountId - 账号池条目 id。
   * @param force - `true` 时跳过缓存（含兼顶），强制回源 —— 面板「刷新」按钮。
   * @returns 读数（成功/兼顶旧值都可能）；`undefined` ⇒ **本次没有可用的缓存读数**，
   *   调用方**照常发请求**（折叠的可用性不得依赖缓存是否接线）。
   */
  readCachedBalance?: (
    accountId: string,
    options: { force?: boolean },
  ) => Promise<{ balance: CreditBalance; stale: boolean; at: number; error?: string } | undefined>
  /**
   * 载荷里的 `force`（面板「刷新积分」按钮）。
   *
   * ⚠️ **必须透传给 {@link CreditsEndpointDeps.readCachedBalance}**（审计 P1-1）：
   *   不传 ⇒ 「刷新」退化成「再读一次缓存」，且在兼顶场景下**看起来成功**
   *   （返回旧值 + 一句「本次查询失败」），比报错更误导。
   */
  force?: boolean
  /**
   * 领取前是否先查一次签到状态（默认 `true`）。
   *
   * CodeBuddy 系拆成「查状态 + 领取」两个独立端点，先查可以省掉一次无效的
   * 领取请求（活动未开 / 今天已领时直接短路）。
   *
   * ⚠️ **本骨架只认这个布尔，不认 provider**：各家的取值由能力表给出
   *（`ProviderCredits.precheckStatus`，见 `src/provider-runtime.ts` 的完整
   * 「哪家 true / 哪家 false 及各自实测理由」）。本文件**不重复那张表**
   * —— 一处语义两套判据必然漂移（本仓库首条红线）。
   *
   * ⚠️ 调用方若省略它，骨架会回落到**默认的 buddy 式** `fetchCheckinStatus`。
   * 对**没有同构状态端点**的渠道（如 loomy）那是**发错端点的必然失败请求** ——
   * 故那些家**必须显式传 `false`**，而不是靠「没配 fetchStatus 就会跳过」这种
   * 想当然的推断（骨架不看 `fetchStatus` 是否存在）。
   */
  precheckStatus?: boolean
  /**
   * 默认实现（`fetchCheckinStatus` / `claimDailyCheckin` / `fetchCreditBalance`）
   * 使用的 fetch。
   *
   * ⚠️ **必须经此注入，不要在调用点直接 `fetch(...)`**：这些默认实现的真实签名是
   * `(credential, product, fetcher)`，而本模块的历史写法是
   * `deps.claim ?? (claimDailyCheckin as unknown as …)`，把三参函数硬转成
   * 「只传两个参数」的类型 —— 于是调用点写 `claim(credential, product, entry)`
   * 时，`entry` 落进了 `fetcher` 位置，运行时抛
   * **`TypeError: fetcher is not a function`**（真实缺陷：用户一键领取 4 个
   * CodeBuddy 账号全部失败）。
   *
   * 现改为**显式包装**默认实现（见下面的 `resolveClaim` 等），既保留 `entry`
   * 给需要它的 provider（TRAE 用 `entry.id` 取签到设备代次），又把 fetcher
   * 正确送进第三参。未提供时用全局 `fetch`。
   */
  fetcher?: typeof fetch
}

/**
 * `credits.status` 逐账号查询的**默认并发度**。
 *
 * 3 的依据与代价见 `collectCreditsStatus` 函数体内那段注释（**不要**用「浏览器
 * 默认 6」来论证 —— 那是不同量纲）。
 */
export const DEFAULT_CREDITS_STATUS_CONCURRENCY = 3

/**
 * `credits.status` 逐账号查询的**并发硬上界**。
 *
 * ## ⚠️ 为什么必须有它（2026-10-22 审计打穿）
 *
 * 初版的上界是 `accounts.length`：
 *
 * ```ts
 * Math.max(1, Math.min(deps.concurrency ?? 3, accounts.length || 1))
 * ```
 *
 * 于是 `deps.concurrency = 1e10`（任何 ≥ 账号数的安全整数）⇒ 并发度 = 账号数
 * ⇒ **31 个账号 = 31 个并发请求打同一上游**（实测峰值 31）。注释说的「3 个并发
 * 压力很低」这个保护**只由 `accounts.length` 约束，没有任何硬顶**。
 *
 * ⇒ 上界改为本常量。它同时给「将来有人把默认值调大」加了一道闸。
 *
 * ⚠️ 取值 8：足够覆盖「账号很多」的正常情形（3 是默认，8 是天花板），且远低于
 * 任何一家上游会当成爬虫的量级。调它需要重新核对 `fetchStatus` 各家的限流策略。
 */
export const MAX_CREDITS_STATUS_CONCURRENCY = 8

/**
 * 解析 `credits.status` 的并发度（**纯函数，可直接单测**）。
 *
 * 逐格行为（2026-10-22 审计逐格实测确认）：
 *
 * | 传入 | 结果 | 说明 |
 * |---|---|---|
 * | `undefined` / `0` / `-1` / `NaN` / `1.5` / `Infinity` / 字符串 | 3 | 非「正整数」一律回落默认 |
 * | `1` | 1 | 恢复旧的完全串行语义 |
 * | `4` | 4 | |
 * | `1e10` / `MAX_SAFE_INTEGER` | **8** | 被 {@link MAX_CREDITS_STATUS_CONCURRENCY} 硬顶（初版这里会变成账号数） |
 * | `accounts.length === 0` | 1 | 起 1 个 worker 立刻返回 -1（**不能**是 0 —— 那会让 `results` 全是空洞） |
 *
 * ⚠️ `concurrency: 0` 的语义是「**回落默认 3**」，**不是**「串行」——要串行请传 `1`。
 *    这条在初版注释里没写，是审计点出来的语义空隙。
 */
export function resolveCreditsStatusConcurrency(raw: unknown, accountCount: number): number {
  const wanted = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0
    ? raw
    : DEFAULT_CREDITS_STATUS_CONCURRENCY
  const capped = Math.min(wanted, MAX_CREDITS_STATUS_CONCURRENCY)
  // ⚠️ `Math.max(1, …)` 不可省：账号数为 0 时 `Array.from({length: 0})` 会让
  //    `Promise.all([])` 立即 resolve，`results` 保持全空洞（返回 `[undefined,…]`）。
  return Math.max(1, Math.min(capped, accountCount || 1))
}

/**
 * 逐账号收集签到状态（**有限并发**，默认 3；见函数体内 `concurrency` 的说明）。
 *
 * ⚠️ **原实现是纯串行**，注释写「顺序执行，避免并发触发风控」。2026-10-22 改成
 * 有限并发，理由与代价见函数体内那段长注释 —— **别再照旧注释改回串行**。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `jet-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export async function collectCreditsStatus<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsStatusResponse['accounts']> {
  // 与 collectClaimResults 同款：显式包装默认实现把 fetcher 送进第三参，
  // 不用 `as unknown as` 掩盖签名差异（见 CreditsEndpointDeps.fetcher 的说明）。
  const fetcher = deps.fetcher ?? fetch
  const fetchStatus = deps.fetchStatus
    ?? (async (credential: TCredential, product: TProduct): Promise<CheckinStatus | null> =>
      fetchCheckinStatus(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  /**
   * **有限并发**（2026-10-22，真实故障）。
   *
   * ## 为什么不再「完全串行」
   *
   * 原实现是纯顺序循环，注释写「避免并发触发风控」。但账号池随用户增删账号
   * **线性增长**，而单账号上游超时是 30 s 级 ⇒ 单渠道耗时 = 账号数 × 单账号耗时
   * ⇒ 「打开 大肥鱼饭碗 设置页」的等待被账号数线性放大。同一时刻 `model.list` 只要
   * 毫秒级（⇒ 慢的不是读目录，是这里）。
   *
   * ## 为什么是 3（以及**推翻**了哪条既有理由）
   *
   * 原注释的理由是「顺序查询避免并发触发风控」。逐项核对后的**真实依据**是：
   *
   * - **实际能走到这里的渠道极少**：只有注册了 `ProviderCredits.fetchStatus` 的
   *   渠道才会调本函数（`credits.status` 端点先判 `statusImpl?.fetchStatus` ——
   *   实测判据在 `creditsOf(credits, req.provider)` 之后、`undefined` 即短路返回），
   *   **本仓库是 4 家**：`minimax` / `minimaxintl`（`fetchMinimaxSigninStatus`）与
   *   `buddy` / `workbuddy`（`fetchCheckinStatus` → `postJson`）；其余渠道走
   *   「如实回 null」的短路分支，**零请求**。
   *   ⚠️ 上游 86e3591 这里写的是「**两家** `minimax` / `minimaxintl`」—— 那是
   *   **他们**那份仓库的事实（其 `provider-credits.ts` 里没有 buddy / workbuddy 条目）。
   *   **本仓库不适用**：`buddy` 有签到状态端点，`workbuddy` 那条是**刻意注册**的
   *   （国际版没有签到接口、但状态端点存在，见 `provider-credits.ts` 里
   *   `workbuddy.fetchStatus` 的注释）⇒ 四家都是**只读状态查询、一次/账号**。
   * - **429 不会被放大**：`minimax` 的 `minimaxFetchWithRetry` 只重试**传输错误**，
   *   而 `buddy` 系走的 `credits.ts` `postJson` **同样不重试 HTTP 状态**
   *   （实测：该文件里 `429` / `retry` 零命中）⇒ 3 并发撞限流只是 3 条同时失败，
   *   不会变成重试风暴；
   * - 签到（**写操作**）走的是 `collectClaimResults`，那里**仍是串行**，本改动不碰它。
   *
   * ⚠️ 因此**不要**照「3 远低于浏览器默认的 6」那条类比来论证安全性（浏览器并发
   * 与服务端风控不是同一量纲，那是初版注释的推理错误）。要论证就按上面三条。
   *
   * ## 顺序与逃逸
   *
   * - 结果**按 `accounts` 原序**写回（`new Array(len)` + 下标），UI 不跳序；
   * - 单账号的凭据缺失 / JSON 损坏 / 名称非法 / 网络失败都只影响它自己；
   * - ⚠️ `deps.warn` 抛错**不得**逃逸成整批失败（初版会：它在 catch 里调用，
   *   一抛就把 worker 的 promise reject 掉）⇒ 已包 try。
   *
   * ⚠️ 并发度可通过 `deps.concurrency` 覆盖（测试与将来调参用）；
   *    `1` 即恢复旧的完全串行语义。上界是 {@link MAX_CREDITS_STATUS_CONCURRENCY}
   *    （**不是** `accounts.length` —— 那会让 31 个账号变成 31 并发）。
   */
  const concurrency = resolveCreditsStatusConcurrency(deps.concurrency, accounts.length)
  const results: RpcCreditsStatusResponse['accounts'] = new Array(accounts.length)
  let cursor = 0
  /** 取下一个待处理下标；无剩余返回 -1（同步自增，单线程下无需加锁）。 */
  const take = (): number => (cursor < accounts.length ? cursor++ : -1)
  const worker = async (): Promise<void> => {
    for (let index = take(); index !== -1; index = take()) {
      const entry = accounts[index] as ProviderAccountEntry
      /**
       * ⚠️ `accountId` / `nickname` 必须在 try **之外**取也会抛（`entry` 是外部对象，
       * 可能是带 getter 的代理 / 冻结对象）。初版把它们的读取放在 `results[index] = …`
       * 那一行 —— 而那一行在 catch **之后**、不受保护 ⇒ 一次抛错就让 worker 的
       * promise reject ⇒ `Promise.all` 短路 ⇒ **整批失败**（违背本函数的设计约定）。
       * ⇒ 先取到局部变量并各自兜底，写结果那一行只做纯赋值。
       */
      let accountId: string | undefined
      let nickname: string | undefined
      let status: CheckinStatus | null = null
      try {
        accountId = entry.id
        nickname = entry.nickname
        let resolved = await deps.resolve(credentialRef(entry.credentialRef))
        if (resolved === undefined && (product as { id?: string }).id === ASTUDIO.id) {
          resolved = await deps.resolve(credentialRef(ASTUDIO.defaultCredentialRef))
        }
        if (resolved !== undefined) {
          const credential = JSON.parse(resolved.value) as TCredential
          status = await fetchStatus(credential, product)
        }
      } catch (error) {
        // 单个账号的凭据缺失 / JSON 损坏 / 名称非法 / 网络失败都不影响其余账号。
        // ⚠️ `deps.warn` 自己抛错也**不得**逃逸（初版会让整批失败）——
        //    告警是尽力而为，它坏了不该让用户看不到其余账号的签到状态。
        status = null
        try {
          deps.warn?.(`[jet-hub] credits.status 账号 ${String(accountId ?? entry.id)} 失败: ${String(error)}`)
        } catch {
          // 告警失败只能静默：这里已经没有更外层的可观测通道了。
        }
      }
      // ⚠️ 纯赋值，不得再抛（`Promise.all` 会因 worker reject 而短路整批）。
      results[index] = { accountId, nickname, status } as RpcCreditsStatusResponse['accounts'][number]
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：签到领取与「是否参与账号池自动选择」无关 —— 停用的
 * 账号同样有当日积分可领，用户点「一键领取」时期望所有账号都尝试一遍。
 * 停用只影响限流切换时的候选集合，不影响这里。
 *
 * 与 collectCreditsStatus 同理：凭据解析位于每个账号自己的 try 之内，
 * 异常只让该账号记为 failed。
 */
export async function collectClaimResults<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsClaimAllResponse> {
  // ⚠️ **默认实现必须显式适配，不能 `as unknown as` 硬转。**
  //
  // 真实签名是 `(credential, product, fetcher)`，而本接口把 `claim` 声明为
  // `(credential, product, entry)`（TRAE 需要 `entry.id` 取签到设备代次）。
  // 历史写法用 `as unknown as` 把这个不匹配「压」过去 —— TypeScript 于是不再
  // 报错，但调用点传的第三个实参是 `entry`，它落进 `fetcher` 位置，运行时抛
  // **`TypeError: fetcher is not a function`**。
  // **真实缺陷**：用户一键领取 4 个 CodeBuddy 账号全部失败，报错就是这句。
  //
  // 修法：显式包装 —— 把 `deps.fetcher`（或全局 `fetch`）送进第三参，
  // `entry` 只交给真正需要它的 provider（它们在自己的分支里注入 `claim`）。
  const fetcher = deps.fetcher ?? fetch
  const fetchStatus = deps.fetchStatus
    ?? (async (credential: TCredential, product: TProduct): Promise<CheckinStatus | null> =>
      fetchCheckinStatus(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  const claim = deps.claim
    ?? (async (credential: TCredential, product: TProduct): Promise<ClaimOutcome> =>
      claimDailyCheckin(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  // 默认保留预检（CodeBuddy 系需要）；LobsterAI 显式传 false 跳过。
  const precheck = deps.precheckStatus !== false
  const results: RpcCreditsClaimAllResponse['results'] = []
  const outcomes: ClaimOutcome[] = []
  /** 仅在 deps.afterClaim 存在时非空；见该钩子的说明。 */
  const growth: RpcBuddyGrowthAccountResult[] = []
  // 整轮共享截止时刻。0 / 负数 / 非有限值一律视为不限时（本地排障用）。
  const rawRound = deps.roundBudgetMs === undefined
    ? DEFAULT_ROUND_BUDGET_MS
    : Number(deps.roundBudgetMs)
  const roundBudgetMs = Number.isFinite(rawRound) ? rawRound : 0
  const roundDeadlineAt = roundBudgetMs > 0 ? Date.now() + roundBudgetMs : undefined
  for (const entry of accounts) {
    let outcome: ClaimOutcome
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        outcome = { kind: 'failed', code: -1, message: '凭据未配置' }
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        if (!precheck) {
          // 领取流程自带状态判断（LobsterAI 的 slot/context 检查在 claim 内部）。
          outcome = await claim(credential, product, entry)
        } else {
          // 先查状态：活动未开启或今日已领则跳过领取请求，减少无效调用
          const status = await fetchStatus(credential, product)
          if (status !== null && !status.active) {
            outcome = { kind: 'inactive', message: '签到活动未开启' }
          } else if (status !== null && status.todayCheckedIn) {
            outcome = { kind: 'already-claimed', message: '今天已签到' }
          } else {
            // 状态查询失败（status 为 null）时仍然尝试领取：
            // 无法确认不代表不能领，交给领取接口以响应体 code 定夺。
            outcome = await claim(credential, product, entry)
          }
        }
      }
    } catch (error) {
      deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 失败: ${String(error)}`)
      outcome = {
        kind: 'failed', code: -1,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    outcomes.push(outcome)
    results.push({ accountId: entry.id, nickname: entry.nickname, outcome })
    // ★ **签到收尾的附加提示**（2026-10-20）：本条对 `claimed` 与 `already-claimed`
    //   **都会跑** —— 后者正是「今天已签到」的账号（本家 precheck 直接回它、
    //   连 `claim` 都不调），而它恰恰最该抽奖。见 `afterClaimNote` 的契约说明。
    //   ⚠️ 必须在 `results.push` **之后**改写（改的是同一对象引用）——
    //      放到之前也行，但那时 `outcome` 还没定稿，语义容易读错。
    if (deps.afterClaimNote !== undefined) {
      try {
        const resolvedForNote = await deps.resolve(credentialRef(entry.credentialRef))
        if (resolvedForNote !== undefined) {
          const credentialForNote = JSON.parse(resolvedForNote.value) as TCredential
          const note = await deps.afterClaimNote(
            credentialForNote, product, entry, outcome,
          )
          if (typeof note === 'string' && note.length > 0) {
            // ⚠️ 只改**这一条** outcome 的 message（客户端渲染的就是它）。
            //    `claimed` 结局原本没有 message 字段 ⇒ 这里补上；
            //    `already-claimed` / `inactive` / `failed` 则是追加在原文案之后。
            const target = results[results.length - 1]!.outcome as { message?: string }
            target.message = typeof target.message === 'string' && target.message.length > 0
              ? `${target.message} · ${note}`
              : note
          }
        }
      } catch (error) {
        // ⚠️ 抽奖的任何异常都不得影响签到结果（契约见 `afterClaimNote`）。
        deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 收尾提示失败: ${String(error)}`)
      }
    }
    // 成长中心等「领取之后」的下钻：与签到共用这一趟循环，避免把凭据解析做两遍。
    // 它的异常只让该项自己失败，不影响已定稿的签到 outcome。
    if (deps.afterClaim !== undefined) {
      try {
        const resolvedForGrowth = await deps.resolve(credentialRef(entry.credentialRef))
        if (resolvedForGrowth !== undefined) {
          const credentialForGrowth = JSON.parse(resolvedForGrowth.value) as TCredential
          const extra = await deps.afterClaim(
            credentialForGrowth, product, entry, outcome, roundDeadlineAt,
          )
          if (extra !== undefined) {
            growth.push(extra)
          }
        }
      } catch (error) {
        deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 成长任务失败: ${String(error)}`)
      }
    }
  }
  return {
    results,
    summary: computeClaimSummary(outcomes),
    ...(growth.length > 0 ? { growth } : {}),
  }
}

/**
 * 逐账号收集积分余额（顺序执行，避免并发触发风控）。
 *
 * 与 {@link collectCreditsStatus} 的关键差异：**这里保留失败原因**。
 * 余额查不到时用户最需要知道"为什么"（凭据过期？网络不通？），把它降级成
 * 一个 null 会让账号卡片显示成空白或 0 分，反而误导。因此失败时带上 error 文案。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择，与"这个账号还剩多少积分"
 * 无关——用户就是想在同一个列表里看全部账号的余额。
 *
 * 凭据解析同样位于每个账号自己的 try 之内：单个账号的凭据缺失/损坏/名称非法
 * 都不会冒泡中断整批。
 */
export async function collectCreditBalances<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsBalancesResponse['accounts']> {
  // 同 collectClaimResults：显式包装，避免 `as unknown as` 掩盖签名差异。
  const fetcher = deps.fetcher ?? fetch
  const fetchBalance = deps.fetchBalance
    ?? (async (credential: TCredential, product: TProduct): Promise<CreditBalance | null> =>
      fetchCreditBalance(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  const fetchDetailed = deps.fetchBalanceDetailed
  const results: RpcCreditsBalancesResponse['accounts'] = []
  /**
   * ⚠️ **这里仍是串行**（与 `collectCreditsStatus` 的有限并发**刻意不同**）。
   *
   * `collectCreditsStatus` 于 2026-10-22 改成有限并发（默认 3），本函数**没有**跟着改，
   * 理由是两者接的上游不同：那个只服务 `minimax` / `minimaxintl` 的**只读 GET**，
   * 而本函数是面板「刷新积分」的主路径，各家余额接口都有速率限制（且部分带写语义，
   * 例如 astudio 的 `importLocalSession`、minimax 的积分端点），并发收益不明而风险
   * 更高。⇒ 要改这里必须**逐家**核对限流策略，不能因为「隔壁改了」就跟着改。
   *
   * ⚠️ 也别把「顺序查询避免并发触发风控」当成通用铁律 —— 它对**写操作**
   * （`collectClaimResults`，签到）与**余额查询**（本函数）成立，对
   * `credits.status` 那种只读单发的状态查询不成立（依据见 `collectCreditsStatus`）。
   */
  for (const entry of accounts) {
    let balance: CreditBalance | null = null
    let error: string | undefined
    let extra: RpcCreditsBalanceExtra | undefined
    /**
     * ★ 先吃共享读数（2026-10-16）：命中即**零网络请求**。
     *
     * ⚠️ **必须排在解析凭据之前**：缓存命中时我们压根不需要凭据 ——
     * 而「凭据读不到」正是最该显示旧值的那种失败（凭据可能被并发续期覆盖）。
     * ⚠️ 命中时**不设 `extra`**（缓存里那份没有该字段，见 `readCachedBalance` 注释）。
     * ⚠️ 兼顶读数（`stale: true`）**照样回传**，并带上 `error` 让 UI 标注
     *    「本次查询失败，显示的是 HH:MM 的数据」—— 这正是用户 2026-10-16 的要求：
     *    拿不到新数据就读旧数据，而不是直接返回错误。
     */
    if (deps.readCachedBalance !== undefined && entry.id !== undefined) {
      // ⚠️⚠️ **`force` 必须透传下去**（2026-10-16 审计 P1-1 实测确认的回归）：
      //   这里原写死 `{}` ⇒ `readOptions.force` 恒 `undefined` ⇒ 端点虽然读了
      //   `payload.force`，但**这一腿永远传不到** ⇒ 面板「刷新积分」按钮在
      //   120 秒 TTL 内点了等于没点，而按钮 title 写着「点此可刷新」—— 假的。
      //   ⇒ 载荷的 `force` 经 `collectCreditBalances` 的 deps 一路透到这里。
      const cached = await deps.readCachedBalance(entry.id, { force: deps.force === true })
      if (cached !== undefined) {
        balance = cached.balance
        if (cached.stale) {
          error = `本次查询失败，显示的是 ${new Date(cached.at).toLocaleString('zh-CN')} 的数据（${cached.error ?? '上游不可达'}）`
        }
      }
    }
    if (balance === null) {
      try {
        let resolved = await deps.resolve(credentialRef(entry.credentialRef))
        if (resolved === undefined && (product as { id?: string }).id === ASTUDIO.id) {
          resolved = await deps.resolve(credentialRef(ASTUDIO.defaultCredentialRef))
        }
        if (resolved === undefined) {
          error = '凭据未配置'
        } else {
          const credential = JSON.parse(resolved.value) as TCredential
          if (fetchDetailed !== undefined) {
            // 带原因的查询：实现自己决定「非积分账户」等业务状态的文案。
            // ⚠️ `entry.id` 必须透传（Gitee issue IKLTZ2）：Gemini 要按**账号**
            // 取出口代理，而账号 id 无法由 `credentialRef` 反查。
            const detailed = await fetchDetailed(credential, product, entry.id)
            balance = detailed.balance
            error = detailed.error
            extra = detailed.extra
            if (balance === null && error === undefined) error = '余额查询失败'
          } else {
            balance = await fetchBalance(credential, product)
            // 查询函数以 null 表示"查不到"（网络/业务码异常），与"余额为 0"不同
            if (balance === null) error = '余额查询失败'
          }
        }
      } catch (caught) {
        deps.warn?.(`[jet-hub] credits.balances 账号 ${entry.id} 失败: ${String(caught)}`)
        error = caught instanceof Error ? caught.message : String(caught)
        balance = null
      }
    }
    results.push({
      accountId: entry.id,
      nickname: entry.nickname,
      balance,
      ...error === undefined ? {} : { error },
      ...extra === undefined ? {} : { extra },
    })
    // ⚠️ **回写共享读数**（规格 §5.7）：只写**成功**的余额 —— 于是聚合折算能命中
    //    面板刚查过的那一条（同一个 `(provider, accountId)` 键）。
    //    ⚠️ 失败**不写**：失败是瞬时的，写进去会让折算侧把「刚失败过一次」当结论
    //    （`balance-cache.ts` 的 `write` 也自带这道守卫，两处一致）。
    if (balance !== null) deps.writeBalance?.(entry.id, balance)
  }
  return results
}

/** `ctx.llm` 上本模块实际用到的部分。 */
export type LlmServiceLike = {
  listProviders?(): readonly { id: string }[]
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>
  listAllModels?(provider: string): readonly { id: string; name: string }[]
  /**
   * 可选：解析单个模型的精确元信息（**思考档位**只在这里）。
   *
   * ⚠️ 声明为可选：网关的档位对照表是附加能力，宿主没提供时目录照常返回，
   * 只是每个模型不带档位字段。
   */
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
}

/**
 * 读取 `ctx.llm` 用于枚举 provider 的模型目录。
 *
 * ## ⚠️ 必须**优先属性访问** `ctx.llm`
 *
 * `src/index.ts` 里 `mountOpenAiGateway` 传的是 `ctx.llm`（属性），而本模块
 * 原先只走 `ctx.get('llm')`。在 connection 上下文里后者可能拿不到
 * `listProviders` —— 结果是**同一时刻**两个页面给出矛盾答案：
 * `/v1/models` 正常返回 36 个模型，而设置页的清单恒为 0 个。
 * 两处服务来源不一致还会让「纠错建议里给的 ID」与「网关实际接受的 ID」可能不同。
 *
 * 用 `ctx.get`（而非插件级 `inject`）作回退：大肥鱼饭碗 的账号管理是主要职责，
 * 模型开关只是附加能力；llm 服务完全缺失时账号面板仍应可用。
 *
 * `listAllModels` 是本插件适配器额外提供的**不受用户黑名单影响**的完整目录
 * （见各适配器的同名方法）。DSH 的 `llm` 服务只保证 `listModels`，故它与
 * `listProviders` 都声明为可选。
 */
export function llmServiceOf(ctx: Context): LlmServiceLike | undefined {
  const direct = (ctx as unknown as { llm?: LlmServiceLike }).llm
  if (direct !== undefined && direct !== null) return direct
  return ctx.get('llm') as LlmServiceLike | undefined
}

/**
 * 采集网关目录（**含思考档位视图**）。
 *
 * ⚠️ 两个 RPC 分支（`gateway.getEnabled` / `gateway.setEnabled`）必须共用本函数：
 * 设置页看到的档位与 `/v1/reasoning-efforts` 返回的必须同源，各算一遍必然漂移，
 * 而漂移的症状是「照着设置页填的对不上网关实际接受的」—— 本功能存在的全部理由
 * 就是消灭这种对照错误，自己再造一个就毫无意义了。
 *
 * 档位要逐模型 `resolveModelInfo` 才拿得到（`listModels` 不带），成本是每个模型
 * 一次**读缓存**的调用（远端目录刚被 `listModels` 拉过），与 DSH 自己
 * `buildModelCatalog` 的形状一致。
 */
export async function collectGatewayCatalog(
  llm: LlmServiceLike | undefined,
  providers: readonly { id: string }[],
  onError: (provider: string, error: unknown) => void,
): Promise<RpcGatewayModel[]> {
  const source: GatewayModelSource = {
    listProviders: () => providers,
    listModels: (provider) => llm!.listModels(provider),
  }
  const resolve = llm?.resolveModelInfo
  if (typeof resolve === 'function') {
    source.resolveModelInfo = (provider, model) => resolve.call(llm, provider, model)
  }
  const groups = await collectGatewayModels(source, onError)
  const views = await collectGatewayEffortViews(source, groups, onError)
  return toGatewayModelIds(groups, views)
}

/**
 * 列出可用于枚举目录的 provider。
 *
 * ⚠️ `listProviders` 取不到时**用已注册适配器的 key 兜底** —— 那些 key 就是本
 * 插件注册的 provider 全集，比「什么都没有」有用得多。仍取不到才返回
 * `undefined`（调用方据此给出明确原因，而不是显示一个空清单让用户去猜）。
 */
export function providerIdsOf(
  llm: LlmServiceLike | undefined,
  modelAdapters: Readonly<Record<string, ModelCatalogSource>> | undefined,
): readonly { id: string }[] | undefined {
  if (llm?.listProviders !== undefined) {
    try {
      const listed = llm.listProviders()
      if (Array.isArray(listed) && listed.length > 0) return listed
    } catch {
      // 落到下面的兜底。
    }
  }
  const keys = Object.keys(modelAdapters ?? {})
  return keys.length > 0 ? keys.map((id) => ({ id })) : undefined
}

/**
 * 注册 大肥鱼饭碗 管理 API 端点。
 *
 * `connection` 服务只存在于 Web bundle；这里用**惰性注入**而非插件级静态
 * `inject`，因此在 headless / CLI profile 下本模块正常加载、只是不注册端点，
 * 而不是把整个插件树卡在 pending（那会让 profile 启动直接失败）。
 */
/**
 * 各 provider auth 实例的**共同部分**（结构化类型），使 `authOf` 不必依赖
 * 各家具体类（逐个 import 会把它们全拖进依赖图）。
 *
 * ⚠️ **名字里的 `JetHub` 比实际语义窄（2026-10-08 独立复审 M-5 实测）**：
 * 本接口有两个**不同层次**的使用方，第二个并不在 JetHub RPC 里 ——
 *
 * | 成员 | 谁在用 |
 * |---|---|
 * | `refreshAccountCredential` | **`jet-hub-rpc.ts` 自己**（`account.refresh` 端点，实测该文件里有真调用） |
 * | `refreshAll` | **`index.ts` 的 runtime 注册循环**（填 `ProviderRuntime.auth.refreshAll`，即 `wiredRefreshTargets()` 的派生依据）。实测本文件里**只有声明、零调用** |
 *
 * ⇒ 读到这里别以为 `refreshAll` 有 JetHub 调用方；它的价值是「让注册循环能用
 * 一个统一的形状遍历各家的实例」。**没有改名**是刻意的：改名要动 `index.ts` 的
 * import 与类型标注，而收益只是名字更准；**语义澄清写在这里即可**。
 */
export interface JetHubAuthLike {
  refreshAccountCredential(refName: string, pool: AccountPool, accountId: string): Promise<void>
  /**
   * 批量续期该 provider 的全部账号。
   *
   * ⚠️ 2026-10-08（Task 10）：`index.ts` 的注册循环用它填
   * `ProviderRuntime.auth.refreshAll`，而后者是 `wiredRefreshTargets()` 的派生依据。
   * 实测各家签名**完全一致**（`(pool) => Promise<void>`）⇒ 无需逐家适配。
   */
  refreshAll(pool: AccountPool): Promise<void>
}

/**
 * 各 provider 的 auth 实例（`registerJetHubRpc` 的命名对象形参）。
 *
 * ⚠️ **键必须是 provider id，不是变量名**：
 * - provider id 是 `qodercn`（无连字符、全小写），而 `index.ts` 里的**变量名**
 *   是 `qoderCn`。若键用变量名，`authOf(auths, 'qodercn')` 就**查不到**中国版
 *   （键 `qoderCn` ≠ id `qodercn`），症状是「中国版账号续期报
 *   `Unknown provider: qodercn`」—— 与本仓库历史上的 `workbuddy` 漏接是同一形态。
 * - 键用 id 后，`account.refresh` 可以直接 `authOf(auths, entry.provider)` 分派。
 *
 * ⇒ 调用点写 `qodercn: qoderCn`（**键是 id、值是变量**），这是刻意的。
 *
 * ⚠️ **每个字段都必须保留具体类型**（不要都改成 `JetHubAuthLike`）——
 * 那会丢掉「全部键必须都在」的类型检查，而「漏接一个 provider 就编译不过」
 * 正是本次改名的核心价值。
 *
 * ⚠️ **刻意不写「N 个字段」**：条数随 provider 增删必然腐坏（本仓库已多次
 * 记录「注释里的数字先烂」），且「数字对不上」会让人怀疑整段约定。
 * 权威条数以本接口的字段为准，一致性由
 * `tests/unit/zcode-wiring.spec.ts` 的「接口键 === 调用点键」锁死。
 */
export interface JetHubAuths {
  readonly codearts: CodeArtsAuth
  readonly buddy: BuddyAuth
  readonly workbuddy: BuddyAuth
  readonly lobsterai: LobsteraiAuth
  readonly qoder: QoderAuth
  /** ⚠️ 键是 **provider id**（`qodercn`），值是 `index.ts` 里的 `qoderCn` 实例。 */
  readonly qodercn: QoderAuth
  readonly trae: TraeAuth
  readonly cline: ClineAuth
  readonly loomy: LoomyAuth
  readonly raccoon: RaccoonAuth
  readonly minimax: MinimaxAuth
  /**
   * MiniMax Code **国际版**（key 是 provider id `minimaxintl`）。
   *
   * ⚠️ 与 `minimax` **共用同一个 `MinimaxAuth` 类**（两站只差产品配置），故这里
   * 的类型相同、只是**另一个实例** —— 与 `qoder` / `qodercn` 同型。
   * 两站账号不互通、凭据 ref 前缀不同（`MINIMAX_*` / `MINIMAXINTL_*`），
   * 若这里的**键与值接错**，症状是「国际站账号的续期去刷了国内站凭据」，
   * 而按 id 查表（`authOf`）会把国际站账号分派到**国内站实例**上。
   */
  readonly minimaxintl: MinimaxAuth
  /**
   * Codely（Unity）的续期实例 —— **可选键**（2026-10-22 A6 接线）。
   *
   * ⚠️ 为何是**可选**而不是必填：它的接线需要同时改到 `index.ts` 的
   * `auths` 对象、`SELF_HEAL_REFRESHABLE_PROVIDERS`、`jet-hub-store.ts` 的前缀表，
   * 以及多张从注册表派生的守卫。写成**必填**会让下一个加 provider 的人
   * 被迫同时改所有消费方（而那些消费方本来就应该按 `channel` 派生）。
   * 缺它时：存在的 `refreshAccountCredential` / `refreshAll` 路径会跳过 codely（与各家同形）。
   */
  readonly codely?: CodelyAuth
  /**
   * ⚠️ **Codely 的键暂不在此声明**（2026-10-20）：接线必须**四处同时**做——
   * ① 本接口加 `codely`；② `index.ts` 的 auths 对象传值；
   * ③ `SELF_HEAL_REFRESHABLE_PROVIDERS` 加 `CODERLY.id`；
   * ④ `jet-hub-rpc-auth-wiring.spec` 的 17→18 与 `refreshAll` 14→15 计数。
   * 缺任一处都会让「接口↔运行时交叉校验」变红（本轮实测：只加接口 ⇒ 2 条红）。
   * 续期实现已就绪（`src/codely-auth-service.ts` 的 `CodelyAuth`），
   * 推理与目录都不依赖它 ⇒ 不接也不影响使用。
   */
  readonly zcode: ZcodeAuth
  readonly gemini: GeminiAuth
  /**
   * OfficeAce（华为 ModelArts MaaS 云端直连）。
   *
   * ⚠️ 值是 **auth 模块命名空间**（`import * as officeaceAuth`），不是 Service 实例
   * —— 该模块导出的是纯函数（`startLogin` / `pollLoginCode` / `completeLogin` /
   * `fetchSubscriptionSummary`），没有类实例。见 `officeace-auth.ts` 模块头。
   */
  readonly officeace: OfficeAceAuth
  readonly accio: AccioAuth
  /**
   * AStudio（讯飞 AstronStudio，2026-10-16）。
   *
   * ⚠️ 与其余各家**不同**：本家没有 `startLogin`、不开回调服务器、没有
   * `authorizeUrl`。`account.create` 用 `importLocalSession(refName)` 把**本机 AStudio
   * 客户端已登录的会话**（磁盘明文 `modelBearerToken`，fact 399/402）读进 DSH 凭据库
   * —— 一次做完的同步路径 ⇒ 返回体靠 `reused: true` 走前端的成功出口。
   */
  readonly astudio: AstudioAuth
  readonly autoclaw: AutoclawAuth
  /**
   * **AutoClaw 国际版**（`autoclawintl`）。
   *
   * ⚠️⚠️ **键与值必须严格对应**：它的值是 `index.ts` 里那个用
   * `product: AUTOCLAW_INTL` 构造的 `AutoclawAuth` 实例。
   * ⚠️ 本段注释**不得出现右花括号字符**：`credits-balance-self-heal.spec.ts` 的
   *    `jetHubAuthsKeys()` 用「找第一个右花括号」的方式截取接口体，注释里出现
   *    该字符会让它**提前截断** ⇒ 后续所有键被判为「不存在」（实测踩过两次）。
   * 若写成 `autoclawintl: autoclaw`（指向国内实例），症状是
   * 「国际站账号的续期去刷了国内站凭据」—— 因为续期用的是**实例上的 product**，
   * 而按 id 查表（`authOf`）会把国际站账号分派到国内站实例上。
   * 这与 `minimaxintl` 的同类风险完全一样（见上方注释）。
   */
  readonly autoclawintl: AutoclawAuth
  /**
   * ModelScope（魔搭）—— **本 fork 独有**（上游 rc.11 仍无此 provider）。
   *
   * ⚠️ 值是 `ModelscopeAuth` **Service 实例**（与 accio 同款），不是命名空间。
   */
  readonly modelscope: ModelscopeAuth
}

/**
 * 按 provider id 取 auth 实例。
 *
 * ⚠️ **键是 provider id**（`qodercn`），不是变量名（`qoderCn`）——
 * 这是 `JetHubAuths` 的接口约定（见其注释）。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `'constructor'`），
 * 把 `entry.provider` 为怪值时误判成「有该 provider」。
 */
export function authOf(auths: JetHubAuths, provider: string): JetHubAuthLike | undefined {
  if (!Object.hasOwn(auths, provider)) return undefined
  return (auths as unknown as Record<string, JetHubAuthLike>)[provider]
}


/**
 * 「显示列表」所需的最小适配器接口：能给出**不套用户黑名单**的完整目录。
 *
 * 只声明用到的方法（结构化类型），避免让本模块依赖五个具体适配器类。
 */
export interface ModelCatalogSource {
  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[]
  /**
   * 聚合目录（**可选** —— 只有聚合适配器实现它）。
   *
   * ⚠️ 必须是**只读且零余额查询**的（规格 §8.3）：面板挂载时会调它。
   * 其余 14 家不实现本方法，故这里声明为可选（结构化类型，不影响它们）。
   */
  describeCatalog?(force?: boolean, signal?: AbortSignal): Promise<{
    models: Array<{
      canonicalId: string
      name: string
      candidates: Array<{
        provider: string
        realId: string
        realName: string
        price: number
        viaPatch: boolean
        rejected: boolean
        /** 三态门控（宿主判定的**权威**结果，客户端只渲染）。 */
        state: 'allowed' | 'rejected' | 'default-rejected'
        /** 该渠道是否已接入临期折算（客户端据此决定「关掉时写哪张表」）。 */
        expiryWired: boolean
      }>
      /** 该模型的**手工顺序**（宿主已按当前候选集过滤）。 */
      order: string[]
    }>
    orderMode: 'expiry' | 'manual'
  }>
  /**
   * 清空选型缓存（**可选** —— 只有聚合适配器实现它）。
   *
   * ⚠️ 改了拒绝表之后调它可立即释放内存。但**正确性不依赖它**：
   * 聚合适配器的缓存键含拒绝表指纹，故改了表就自动不命中旧条目
   *（见 `AggregateAdapter.routingFingerprint` —— 2026-10-15 起为四项：拒绝表 + 白名单
   *  + 手工顺序表 + 排序模式）。
   */
  clearChoiceCache?(): void
  /**
   * 目录健康快照（**可选** —— 只有目录来自**多个外部来源**的适配器实现它，
   * 目前只有 `cline`：它的 `cline-pass/*` 条目与图片能力**只由 models.dev 提供**，
   * 而那是 5.39 MB 的外部站点、经常拉不到）。
   *
   * ⚠️ 必须**零 IO**：`provider.status` 在设置页挂载时对**每个**供应商都会调它，
   * 一旦它触发网络请求，首屏会被拖慢（本端点全程只用同步内存副本正是为此）。
   * ⚠️ 抛错会被调用点吞掉（诊断不得反噬主流程），故实现方可以放心地
   * 「读到什么就报什么」。
   */
  describeCatalogHealth?(): CatalogHealth
  /**
   * 「**目录是否已可用于批量写操作**」的本地探测（**可选** —— 目前只有聚合适配器实现它）。
   *
   * ## ⚠️⚠️ 为什么需要它（Critical：Task 7 的目录非阻塞把 IKJW33 缺陷重新打开了）
   *
   * `fullCatalogIds` 的判据是「**远端读到即可**」（`remoteError` 为空 ⇒ 认为成功）。
   * 对**其余 19 家**，目录是**固定 / 编译期兜底表 + 远端覆盖**，「读到」与「读全」
   * 基本等价。而聚合的目录是**逐渠道动态推导**的，且 Task 7 之后它的 `listModels`
   * **不再同步等上游** ⇒ 冷启动时它**立刻**返回 `['auto']` ⇒ 远端那一半「读成功」
   * 但只含 1 条 ⇒ 用户点「关闭聚合供应商」只关掉 `auto`，
   * `provider.setEnabled` 却返回 `ok:true` / `changedCount:1`，另外两个虚拟模型
   * **仍然可选**（`provider.status` 则把这帧错判成 `closed:true`）。
   *
   * ⇒ 有实现时，**两个端点都先问它**；`ready === false` 时按「目录不完整」处理
   *（`setEnabled` 拒绝、`status` 报安全方向 `closed:false`）。
   *
   * ⚠️ 必须**同步且零 IO**：`provider.status` 在设置页挂载时对每个供应商都调，
   *    一旦它触发网络请求会拖慢首屏（本接口其它成员的同一约束）。
   * ⚠️ 抛错会被调用点吞掉（按「不可用」处理，即安全方向），故实现方可以放心报。
   */
  catalogReadyForBulkWrite?(): { ready: boolean; reason?: string }
  /**
   * 清空**临期折算缓存**（**可选** —— 只有聚合适配器实现它）。
   *
   * ## ⚠️⚠️ 为什么领取（claim）之后必须调它（真实缺陷，对抗审计实测证伪，2026-10-07）
   *
   * `createExpiryProbe` 的折算缓存（TTL 60 秒）**也缓存 `UNUSABLE`** —— 这是刻意的
   * （见 `aggregate-expiry.ts` 的 `cacheAndReturn`：一个渠道「现在没账号」60 秒内不会变）。
   *
   * 但 `UNUSABLE` 现在**新增了一个来源**：`zcodeExpiry` 把「余额为 0」判成 `UNUSABLE`
   *（修掉「额度已尽仍被 auto 选中」的真实缺陷）。而 zcode 的每日赠送额度**要先领取
   * 才进 `balances` 桶** ⇒ 于是出现这个时序：
   *
   * 1. 用户请求 → 余额 0 → 写入 `UNUSABLE`（缓存 60 秒）；
   * 2. 用户去面板点「一键领取」→ **领取成功、余额进桶**；
   * 3. 用户立刻用 auto → **仍命中第 1 步的 `UNUSABLE`** ⇒ 报「没有任何可用候选」。
   *
   * ⇒ 用户会以为「签到没用」或「auto 坏了」，而账号其实已经好了。
   *
   * ⚠️ 旧实现不会暴露这个问题：它那时在「余额 0 但有可领活动」时返回**当日**
   *（可当选），根本不写 `UNUSABLE`。是本次收窄**引入了**这个时序。
   *
   * ⚠️ 已有的两个清理入口（`pool.onAccountAdded` 与拒绝表变更）**都不覆盖领取** ——
   * 领取既不新增账号、也不改拒绝表。故必须在领取成功后**显式**清一次。
   */
  clearExpiryCache?(): void
  /**
   * 「上次**实际**转发成功的渠道」（**可选** —— 只有聚合适配器实现它）。
   *
   * ⚠️ 必须是**纯内存读、零网络零余额查询**（规格 §6.3 的 P2）：用量徽标在
   * **门控阶段**就要拿到它（重定向必须发生在 `supportsCreditBalance` 门控之前），
   * 查网络会让外层渲染抖动。
   *
   * @param canonicalId - 省略时返回「最近一次任意虚拟模型的转发渠道」。
   */
  activeProvider?(canonicalId?: string): string | null
  /**
   * 「按临期排序」用的候选到期时刻（**可选** —— 只有聚合适配器实现它）。
   *
   * ⚠️ 这是**唯一**会做余额探测的面板方法，**只在用户显式点「按临期排序」时**调用
   *（`describeCatalog` 的零查询契约不受影响，见那里的注释）。
   *
   * @param force - `true` 绕过探针的 60 秒折算缓存（面板每 5 分钟自动重探 / 手动点击时用）。
   */
  describeExpiryOrder?(signal?: AbortSignal, force?: boolean): Promise<Record<string, number>>
  /**
   * auto 的**实际转发历史**与选型入口（**可选** —— 只有 `jet-hub-auto` 实现它）。
   *
   * ## ⚠️ 为什么放在 `modelAdapters` 表里，而不是给 `registerJetHubRpc` 加一个位置参数
   *
   * 那个函数是**位置传参**，其形参列表有成文警告「历史上已因少传/插队错位复发 6 次」，
   * 且 `zcode-wiring.spec.ts` 有一条**派生式不变量**：
   * 「客户端 `PROVIDERS` 条数 + 1 == 形参个数」。
   * 加第 17 个位置参数会直接打破它（实测：10 条接线断言同时变红），而那条不变量
   * 正是为了防「中间某个 provider 位置错位 = 拿 A 的实例当 B 用」这类真实故障。
   *
   * ⇒ 走**按 id 键控**的 `modelAdapters` 表：加一个键不影响任何位置，也不影响
   *   那条不变量（它只数形参）。聚合 provider 同样在这张表里（见 `index.ts`）。
   *
   * ⚠️ 返回类型复用 `auto-badge.ts` 的 `AutoBadgeState`（**唯一权威**）——
   *    在 `usage.badge` 里再声明一份同样的形状必然漂移。
   */
  autoState?(): AutoBadgeState
}

/**
 * 广播「模型目录可能已变化」。
 *
 * ⚠️ 实现已抽到 `src/catalog-broadcast.ts`（issue IKJVTF）：那里是**唯一**的
 * 广播实现，十个适配器的「远端目录落地」也走它。此前本文件另有一份
 * `try { ctx.emit(...) } catch`，与适配器侧完全独立 —— 两份实现必然漂移，
 * 故现改为同名导入。
 *
 * ## 为什么改黑名单后必须广播
 *
 * 否则「关闭后选择器里仍能看到该模型，重启后才消失」（真实缺陷，用户报障）。
 * 根因在客户端而非适配器：`dsh-client-ui-model-selection` 的
 * `ModelCatalogDirectory` 把 `modelCatalog` 响应存进一个 `status === 'ready'`
 * 即**短路返回缓存**的 store，只在四个转发的宿主事件上 `refresh()`：
 * `llm/adapters-updated` / `settings/document-updated` /
 * `credentials/record-updated` / `credentials/reference-updated`。
 *
 * 0.1.7 起黑名单落在插件自有文档 `$DSH_HOME/jet-hub/state.json`（不再经 settings
 * 文档，见 jet-hub-store.ts），因此写开关**不会**触发上述任何一个事件 → 客户端
 * 一直复用旧目录，直到重启（`connection/reset` → `resetGeneration()`）才重拉。
 *
 * 四者中 `llm/adapters-updated` 最贴合：按契约它是**无载荷**的「目录可能变了，
 * 请重新读 listModels」通知（dsh-llm README：*consumers re-read the registries*），
 * 正是这里要表达的语义。它也在 `API_REMOTE_FORWARDED_EVENTS` 白名单里，故会真的
 * 送达浏览器。不改变拓扑，故 dsh-llm 的 invariant 监听（对每个 provider 读一次
 * `retryPolicy`）必然通过，不会误报 INVARIANT。
 *
 * ⚠️ **通知失败不能反噬已经落盘的开关**：否则用户看到「切换失败」而实际已生效，
 * 再点一次又因幂等而看似「无效」，比不提示更难排查。故 `catalog-broadcast.ts`
 * 自行吞掉异常只记日志。
 */

/**
 * `fullCatalogIds` 的返回值。
 *
 * ⚠️ **刻意是「部分成功」的形状**，因为三个调用点对目录的**完整度要求不同**
 *（这是本函数不能再返回单一 `{ ids } | { error }` 的原因）：
 *
 * | 调用点 | 需求 | 对「远端那一半缺失」的动作 |
 * |---|---|---|
 * | `model.setAllDisabled` | **必须完整**（要写黑名单） | 判 `complete`：**拒绝且不落盘** |
 * | `provider.setEnabled` | **远端读成功即可**（要写黑名单） | 判 `remoteError`：读失败**拒绝**；读到但为空**照常关闭**；**适配器自报未就绪（`notReady`）拒绝** |
 * | `provider.status` | 只要「能否证明已关闭」 | `remoteError` 或 `notReady` ⇒ **保守报未关闭**（安全方向） |
 * | `account.test` | **尽力而为**（只要一个 id 就能测） | 用拿到的那些照常测 |
 *
 * ⚠️ `provider.setEnabled` 刻意**不**与 `model.setAllDisabled` 同判据：
 * 前者是**供应商级**开关，「远端读到但为空」（无账号门控）时并集只剩适配器
 * 兜底表，而该供应商本来就没有账号 ⇒ 模型选择器里一条都选不到，用兜底表写黑名单
 * 不会造成「显示已关闭而模型仍可选」；若按 `complete` 拒绝，**无账号的供应商
 * 将永远无法关闭**。后者是模型级批量操作，语义上要求目录完整，维持原判据。
 * ⚠️ 两者共用 {@link fullCatalogIds}（目录来源只此一处），差异只在失败时的动作。
 */
export interface FullCatalogResult {
  /** **并集**（适配器目录 ∪ 远端目录），已去重。 */
  ids: string[]
  /**
   * **远端目录读出且非空**（即「完整目录」）。
   *
   * ⚠️ 它**不能**被就地替换成「`ids` 是否为空」：冷缓存下适配器兜底表会让
   * `ids` 看起来非空，而它只是**子集**。
   *
   * ⚠️ 它刻意**合并了两种**「目录不完整」形态：
   *
   * 1. **远端读失败**（超时 / 抛错 / 无 llm 服务）⇒ 见 {@link remoteError}；
   * 2. **远端读到但为空** —— `createModelCatalog` 在「无已登录账号」时门控
   *    返回 `[]`，含义是「**看不到**」而**不是**「该 provider 一个模型都没有」。
   *    ⚠️ 此时适配器兜底表**仍可能有内容**，照它写「关闭全部」的黑名单就是
   *    **同一个缺陷的另一个入口**（实测：远端 `[]` + 兜底表 1 条 ⇒ 「关闭全部」
   *    只关那 1 条并返回成功）。⚠️ 这一种**没有** `remoteError`（它不是错误）。
   *
   * ⚠️⚠️ **调用方按各自语义选择判据，不要盲目统一**（两个写黑名单的端点
   * **刻意不同判据**，理由见 {@link FullCatalogResult} 的表）：
   *
   * - `model.setAllDisabled`（模型级批量）⇒ 判 **`complete`**，不完整即拒绝；
   * - `provider.setEnabled`（供应商级）⇒ 判 **`remoteError`**，因为形态 2 下
   *   该供应商没有账号、模型选择器本就选不到任何东西，用兜底表落盘是自洽的，
   *   且按 `complete` 拒绝会让无账号供应商**永远无法关闭**；
   * - `readableCatalogIds`（提示层）⇒ 判 `complete`，不完整即放弃核对。
   */
  complete: boolean
  /**
   * 目录不完整的**原因**；仅当是「远端读失败」时有值。
   *
   * ⚠️ 为 `undefined` 而 `complete === false` ⇒ 就是上面第 2 种形态
   *（远端读到但为空）。`provider.setEnabled` 据此决定「照常关闭」，
   * 提示层据此放弃核对。
   * ⚠️ **它不承载第 3 种形态**（适配器自报「目录尚未就绪」）—— 那一种见
   * {@link notReady}，因为两者的**用户动作不同**（那个要等 / 重试，这个要登录）。
   */
  remoteError?: string
  /**
   * **适配器自报「目录尚未就绪」**（只有实现 `catalogReadyForBulkWrite` 的适配器
   * 会给出值，目前只有聚合）。
   *
   * ## ⚠️⚠️ 这是第 3 种「目录不完整」形态，**判据与处置都与前两种不同**
   *
   * | 形态 | `remoteError` | `notReady` | `provider.setEnabled` 的动作 |
   * |---|---|---|---|
   * | 远端读失败（超时/抛错） | 有值 | 无 | **拒绝**（既有守卫） |
   * | 远端读到但为空（无账号门控） | 无 | 无 | **照常关闭**（既有取舍，否则无账号供应商永远关不掉） |
   * | **适配器说「我这份目录还不是全的」** | 无 | **有值** | **拒绝**（本字段引入的原因） |
   *
   * 为什么第 3 种**不能**塞进 `remoteError`：那个字段的语义是「远端**读失败**」，
   * 而这里远端**读成功了**（`listModels` 正常返回了 `['auto']`）—— 把它记成读失败
   * 会让排障者去查网络，而真相是「聚合目录的逐渠道推导还没跑完」。
   * 为什么**不能**塞进 `complete === false`：那会让它落进第 2 种形态的「照常关闭」，
   * 正是本次要修的缺陷（只关掉 `auto` 却返回成功）。
   */
  notReady?: string
}

/**
 * 取某 provider 的**模型 id**（两个目录来源的并集），供「关闭全部」「关闭供应商」
 * 与「测试账号选模型」共用。
 *
 * ## ⚠️⚠️ 并集是必须的，不能「优先 `listAllModels()`」（真实缺陷）
 *
 * 本仓库有两个「目录」来源，**并不总是同源**：
 *
 * | 来源 | 形态 |
 * |---|---|
 * | `modelAdapters[provider].listAllModels()` | 不套黑名单；**冷缓存下是编译期兜底表（子集）** |
 * | `llm.listModels(provider)` | **真实远端目录 − 黑名单**；异步、可能失败 |
 *
 * 原实现是「**优先** `listAllModels()`，只要它存在就短路、根本不看 `listModels()`」，
 * 而冷缓存下兜底表是**子集**（`model-catalog.ts` 的 `cached ?? config.syncCatalog()`；
 * 实测 `cline` 冷缓存只有 **3** 条，远端有 **460** 条）⇒ 两个关闭方向都会写出
 * **只含兜底表条目**的黑名单，而端点返回「成功」：
 *
 * - `model.setAllDisabled`：用户以为整个供应商已关闭，而**几百个模型仍可选**；
 * - `provider.setEnabled`：更重 —— `provider.status` 的 `closed` 判据是
 *   `total > 0 && disabled === total`，而 `total` 也取自 `listAllModels()`
 *   ⇒ 界面**显示为已关闭**，对话框里那几百条却**仍能选中**。这正是该端点注释里
 *   列为**必须避免**的「账号全停用但模型仍可见」形态的镜像。
 *
 * 用户报障路径**恰恰是冷缓存**（脚本/设置页首次打开就点「关闭全部」）。
 * ⚠️ 既有注释其实早已立下约定「失败时**不落盘** —— 否则会写入一个不完整的
 * 黑名单，用户看到『关了一半』且无从判断原因」，但 `listAllModels()` 冷缓存返回
 * 子集时它**不算失败**，于是绕过了那条守卫。并集把那个缺口补上。
 *
 * ## ⚠️ 适配器那一半**不能丢**（即使远端成功）
 *
 * `listModels()` 会把**已被用户关闭**的模型过滤掉，而适配器目录带着它们。
 * 漏掉会让 `provider.setEnabled` 的 `ids.length === 0` 判据在「全部已关闭」时
 * 误判成「没有可关闭的模型」而拒绝操作。
 *
 * ## ⚠️ 与 `readableCatalogIds` 的分工：**目录来源只此一处**
 *
 * 两者共用本函数取目录，区别只在**失败时的动作**：写黑名单的调用方**拒绝操作**，
 * 提示层（`readableCatalogIds`）**放弃核对**。
 * ⚠️ **不要在这里或那里再各写一份目录来源逻辑** —— 本仓库踩过「一文件两套同义
 * 判据必然先腐坏一套」（IKJW33 修复时实测出内层判据在生产路径上不可达）。
 *
 * ⚠️ **远端读取带超时**（{@link CATALOG_READ_TIMEOUT_MS}）：这是写操作的前置读取，
 * 不能把用户点开关的等待无限拉长。
 *
 * @param ctx - 取 `llm` 服务用。
 * @param modelAdapters - 设置页目录来源（并集的一半，同步、不产生网络请求）。
 * @param provider - 目标 provider。
 * @returns 见 {@link FullCatalogResult}（**部分成功**是合法结果）。
 */
export async function fullCatalogIds(
  ctx: Context,
  modelAdapters: Readonly<Record<string, ModelCatalogSource>> | undefined,
  provider: string,
): Promise<FullCatalogResult> {
  // ── 来源一：适配器目录（同步；但**冷缓存下是兜底子集**）──
  // ⚠️ 它抛错**不独自决定成败**：远端那一半仍可能成功，故单独吞掉。
  const adapterIds: string[] = []
  try {
    for (const model of modelAdapters?.[provider]?.listAllModels() ?? []) adapterIds.push(model.id)
  } catch {
    /* 适配器异常不该让整个读取失败：远端目录仍可用 */
  }

  // ── 来源二：远端真实目录（权威；冷缓存下会真发一次拉取）──
  const llm = llmServiceOf(ctx)
  if (llm === undefined) {
    // ⚠️ 远端拿不到 ⇒ 只剩兜底子集 ⇒ **不可用于写黑名单**（`complete: false`）。
    return { ids: adapterIds, complete: false, remoteError: 'llm 服务不可用' }
  }
  let remoteIds: string[]
  try {
    remoteIds = (await withTimeout(llm.listModels(provider), CATALOG_READ_TIMEOUT_MS))
      .map((model) => model.id)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ids: adapterIds, complete: false, remoteError: `读取模型列表失败：${reason}` }
  }

  // ⚠️⚠️ **第 3 种形态：适配器自报「我这份目录还不是全的」**（Critcal，Task 7 引入）。
  //
  // 上面那一步「远端读到」对**动态目录**的 provider（目前只有聚合）**不再等价于
  // 读全**：Task 7 之后聚合的 `listModels` 立刻返回**已知**目录（冷启动时只有
  // `auto`），逐渠道推导转后台 ⇒ 这里会看到「读成功、但只有 1 条」。
  //
  // 不拦的后果（控制方实测）：
  // ```
  // setEnabled(false) 结果 = {"written":["auto"],"changedCount":1}   ← 只关了 auto！
  // 稳态对照       = {"written":["auto","deepseek-v4-1-flash","glm-5-3"],"changedCount":3}
  // ```
  // 用户点「关闭聚合供应商」→ 提示「已关闭 1 个模型」、返回 `ok:true`，而另外两个
  // 虚拟模型**仍可选** —— 正是本文件 `provider.setEnabled` 注释里明文禁止的缺陷形态。
  //
  // ⚠️ **必须排在「远端读到但为空」那一步之前**判：冷帧下聚合的远端也会是
  // `['auto']`（非空）⇒ 不加这一步会一路落到下面「成功」分支。
  // ⚠️ 探测**抛错按「不可用」处理**（保守方向：宁可拒绝一次关闭，也不要写出残缺
  // 黑名单后仍报成功）。
  try {
    const readiness = modelAdapters?.[provider]?.catalogReadyForBulkWrite?.()
    if (readiness !== undefined && readiness.ready !== true) {
      return {
        ids: [...new Set([...adapterIds, ...remoteIds])],
        complete: false,
        notReady: readiness.reason ?? '目录尚未就绪',
      }
    }
  } catch {
    return {
      ids: [...new Set([...adapterIds, ...remoteIds])],
      complete: false,
      notReady: '目录就绪状态探测失败',
    }
  }

  // ⚠️⚠️ **远端读到但为空 ⇒ 同样不可用于写黑名单**（`complete: false`，且**无**
  // `remoteError` —— 它不是错误）。含义是「看不到」（无账号门控），不是
  // 「该 provider 一个模型都没有」；此时适配器兜底表仍可能有内容，照它写黑名单
  // 就是同一个缺陷的另一个入口（见 `FullCatalogResult.complete` 的长注释）。
  return {
    ids: [...new Set([...adapterIds, ...remoteIds])],
    complete: remoteIds.length > 0,
  }
}

/**
 * 核对目录时的读取预算（毫秒）。
 *
 * 开关是**写操作**，不该被远端目录拉取拖住（见 `readableCatalogIds` 的注释）。
 * 取 2 秒：缓存已热时是纯内存读、立即返回；冷缓存下的正常远端读取也在秒级内
 * 完成，超过它说明上游正卡着 —— 此时放弃核对、照常写入开关。
 * ⚠️ 不要为了「多拿到几次核对」而调大：这条预算**直接加在用户点开关的等待上**。
 */
export const CATALOG_READ_TIMEOUT_MS = 2000

/**
 * 给一个 Promise 加超时；超时即 reject（调用方按「读不到」处理）。
 *
 * ⚠️ **不取消底层请求**（`listModels` 不接受 signal）：只是不再等它。
 * 这是刻意的 —— 底层那次拉取的结果仍会填进 `ModelCatalog` 的缓存，
 * 对后续的 `model.list` 有用，取消反而浪费。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`catalog read timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/**
 * 核对一批 id 是否**真的在**当前模型目录里，为「静默空操作」生成 warnings。
 *
 * ## 解决的报障（Issue IKJW33，2026-10-08）
 *
 * 对**已从上游目录消失**的模型 id 调 `on`/`off`，旧实现返回「成功 1」却
 * **什么都没发生、且没有任何警告**。用户实测两例：
 * `cline/cline-free/deepseek-v4.1-flash` 与 `cline/stealth/space-bunny-alpha`
 * 在 10-05 记录「上游 model not found」后已从 cline 目录消失（490 → 489）。
 * 后果：① 脚本/AI 助手据「成功 1」误判开关已生效；② 黑名单里残留幽灵条目，
 * 模型在 GUI 已看不见、关闭记录却还挂着，导入号池时还会被一起搬走。
 *
 * ## ⚠️⚠️ 判据必须是**两个目录来源的并集**（两个方向都已被实测证伪）
 *
 * 本仓库有两个「目录」来源，**它们并不总是同源**：
 *
 * | 来源 | 谁在用 | 形态 |
 * |---|---|---|
 * | `llm.listModels(provider)` | 对话框模型选择器 | **真实远端目录 − 黑名单** |
 * | `modelAdapters[provider].listAllModels()` | **设置页**（`model.list`） | 不套黑名单；**冷缓存下是编译期兜底表** |
 *
 * 只取任一个都被实测证伪：
 *
 * - **只取 `listAllModels()`**（本修复第一版）⇒ 冷缓存下兜底表是**子集**：
 *   实测 `cline` 冷缓存只返回 **3** 条（`fallbackModels`），远端却有 **460** 条
 *   ⇒ 远端任意正常模型都被误报。而 issue 的复现路径**恰恰是冷缓存**
 *   （脚本直接调 `on`，从未先跑 `list`）。
 * - **只取 `listModels()`**（第二版）⇒ 在 `opencode` 上**反向**误报：它的
 *   `listAllModels()` **恒返回**编译期兜底表（永不读远端），而 `listModels()`
 *   在**只有匿名槽**时还会 `filter(isFree)` ⇒ 设置页看得见的付费模型在
 *   `listModels()` 里**一个都没有**。审计实测：无付费账号时关闭 13 个设置页
 *   可见的模型，**13/13 全部收到假警告**（「该模型可能已被上游下架」，
 *   而它并没有下架，只是当前匿名身份看不到）。
 *
 * ⇒ 取**并集**。方向刻意是「宁漏勿误」：`known` 越大 ⇒ `missing` 越小 ⇒
 * 误报越少。提示类信息的**误报比漏报糟得多**（用户会对整类提示脱敏），
 * 故宁可漏报（少一条提示）也不能误报（把正常模型说成已下架）。
 *
 * ## ⚠️⚠️ `listModels()` 失败**必须整体放弃核对**，不得退化成「只用兜底表」
 *
 * `listModels()` 是**唯一**能反映远端真实目录的来源（`listAllModels()` 在
 * 冷缓存与 opencode 上都可能是编译期快照）。它读不到（超时 / 抛错 / 空目录）时
 * 若仍拿 `listAllModels()` 去核对，就**退化回第一版的误报形态**。
 * ⇒ 直接返回 `undefined`（放弃核对），开关照常写入、不带任何警告。
 *
 * ⚠️ **这是刻意的取舍，不是漏写**：代价是「远端目录首次拉取就失败」时
 *（凭据过期 / 上游抖动）连兜底表也不用来核对 ⇒ issue 的原始场景
 *（脚本冷启动直调 `on`）恰好最可能命中这条**漏报**面。
 * 接受它，因为反向（拿快照当权威）会把**正常模型**说成已下架。
 *
 * ## ⚠️ 黑名单必须在**本函数内部**、于 `await` **之后**读
 *
 * 下面把黑名单里 `true` 的 id **并回** `known`：那是「在目录里、但被用户关着」，
 * 用户能重新打开它 ⇒ 不能判成「不在目录」。
 *
 * ⚠️⚠️ **这个读取刻意放在 `await listModels()` 之后**（真实缺陷，审计实测）：
 * 若由调用方在 `await` **之前**取快照传进来，则「快照」与「实际写入」之间隔着
 * 一次 `listModels`（冷缓存下最长 {@link CATALOG_READ_TIMEOUT_MS}）—— 期间
 * 另一路 RPC 的写入会让快照失真，实测出现「**实际产生了变更却报『本次没有产生
 * 任何变更』**」（与 issue 要消除的误导同型）。放在这里之后，从读黑名单到写入
 * 全是**同步代码、无 await** ⇒ 窗口归零。
 *
 * ## ⚠️ `dead` 表里的 id 算「不在目录」，但文案必须可操作
 *
 * 失效模型被 `withDeadModelPruning` 从**两个来源**同时剔除（`llm.listModels`
 * 与 `modelAdapters.listAllModels` 都是 pruned 代理），而 `model.list` 又把它们
 * 补回设置页（带 `dead:true`）供用户点「重新显示」⇒ 它们天然落在判据的
 * 「目录外」。issue 的两例正是这个形态。只说「不在目录」不够 ——
 * 必须告诉用户去点「重新显示」（`model.clearDead`），否则他无从下手。
 *
 * ## ⚠️ 放弃核对（返回 undefined）的三种情况
 *
 * 1. **`listModels()` 读失败**（超时 / 抛错）—— 理由见上，这是**关键**一条；
 * 2. **`listModels()` 返回空**：`createModelCatalog` 在「无已登录账号」时返回
 *    `[]`（门控隐藏整个 provider）⇒ 空目录意味着「看不到」而非「全部下架」；
 * 3. **`llm` 服务缺失**：拿不到远端目录，无从核对。
 *
 * ⚠️ **目录来源取自 `fullCatalogIds`，本函数不自己再取一遍** ——
 * 两处各写一份「哪个来源优先」的判据，就是本仓库踩过的
 * 「一文件两套同义判据必然先腐坏一套」（那次实测出内层判据在生产路径上**不可达**）。
 * 这里只负责把它的**失败**翻译成「放弃核对」（提示层错了不如不说），
 * 而两个关闭方向把同一个失败翻译成「拒绝操作」（写黑名单必须完整）。
 *
 * ⚠️ **必须带超时**：`listModels()` 在**冷缓存**下会真的发一次远端拉取
 *（`loadCatalog()`），于是「开关」这个原本纯本地的写操作多了一条网络依赖。
 * 开关**绝不能**被远端拖住 —— 用户点一下开关却转圈几十秒，比少一条提示糟得多。
 * 故核对是**尽力而为**：超时（{@link CATALOG_READ_TIMEOUT_MS}）即放弃核对。
 * ⚠️ GUI 路径上缓存通常已热（用户先看到模型列表才会去点开关），此时是纯内存读、
 * 无新增延迟；只有「脚本冷启动直接调开关」才可能等一次拉取。
 *
 * @param ctx - 取 `llm` 服务用。
 * @param pool - 读黑名单（**在 await 之后**，理由见上）。
 * @param modelAdapters - 设置页目录来源（并集的一半）。
 * @param provider - 目标 provider。
 * @returns 可核对的目录 id 集合；`undefined` = **放弃核对**（三种情况见上）。
 */
export async function readableCatalogIds(
  ctx: Context,
  pool: AccountPool,
  modelAdapters: Readonly<Record<string, ModelCatalogSource>> | undefined,
  provider: string,
): Promise<ReadonlySet<string> | undefined> {
  const catalog = await fullCatalogIds(ctx, modelAdapters, provider)
  // ⚠️⚠️ **目录不可用 ⇒ 整体放弃核对**（判 `complete`，它同时覆盖
  // 「远端读失败」「远端读到但为空」「**适配器自报未就绪**（`notReady`）」三种形态
  // —— 见该字段的长注释）。第三种是 Task 7 引入的（聚合的 `listModels` 不再同步
  // 等上游 ⇒ 冷帧只有 `auto`）：那时并集是残缺的，拿它核对会**大面积误报**
  // 「该模型可能已被上游下架」。
  // 不得退化成「只用 listAllModels 兜底表」：那会退回第一版的大面积误报。
  // 提示层错了不如不说。
  if (!catalog.complete) return undefined
  const known = new Set(catalog.ids)
  // ⚠️ 并回「被关着」的 id —— **必须在 await 之后读**（理由见函数头）。
  // ⚠️ `fullCatalogIds` 的并集**已含**适配器目录里那些被关闭的 id，
  // 但**不含**「既不在适配器目录、也不在远端目录」的历史死键（那些只存在于
  // 黑名单里）。它们必须并回来：打开方向正是清理它们的唯一路径。
  for (const [id, disabled] of Object.entries(pool.listDisabledModels(provider))) {
    if (disabled === true) known.add(id)
  }
  return known
}

/**
 * 为「静默空操作」生成 warnings（纯函数，判据与取舍见 {@link readableCatalogIds}）。
 *
 * @param known - 可核对的目录 id 集合（**已含**黑名单里的 id）；`undefined` = 放弃核对。
 * @param provider - 目标 provider（查 dead 表给可操作指引）。
 * @param ids - 本次操作的模型 id（已去重）。
 * @param disabled - 目标状态：true = 关闭，false = 打开。
 * @returns 警告文案（无警告时为空数组）。
 */
export function catalogWarnings(
  known: ReadonlySet<string> | undefined,
  provider: string,
  ids: readonly string[],
  disabled: boolean,
): string[] {
  if (known === undefined) return []
  const missing = ids.filter((id) => !known.has(id))
  if (missing.length === 0) return []

  const dead = deadModelIdsFor(provider)
  /** 失效模型的正确动作是「重新显示」，必须给出这条可操作指引。 */
  const hint = (id: string): string => dead.has(id)
    ? '（已被判为失效，可在模型列表里点「重新显示」恢复）'
    : '（该模型可能已被上游下架）'

  return missing.map((id) => disabled
    // 关闭方向：写入生效了，但它本来也不在可选列表里，故不影响实际可选集合。
    ? `${id} 不在当前模型目录，本次关闭不影响可选列表${hint(id)}。`
    // 打开方向：黑名单里没有它（有的话已被 `readableCatalogIds` 并回 `known`）
    // ⇒ 本次既没写也没删，是纯空操作。
    : `${id} 不在当前模型目录，且黑名单里没有它 —— 本次没有产生任何变更${hint(id)}。`)
}
