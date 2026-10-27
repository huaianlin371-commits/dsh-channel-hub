import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
// Codely 的续期服务对象（2026-10-20：推理已走 HTTP 自签，这里只负责续期）
import { CodelyAuth } from './codely-auth-service.js'
import { createHash } from 'node:crypto'
import { PROVIDER as CODEARTS_PROVIDER } from './llm-adapter.js'
import { startCatalogPrewarm } from './catalog-prewarm.js'
import { broadcastCatalogChanged } from './catalog-broadcast.js'
import { CodeArtsAuth } from './service.js'
import { LOOMY } from './loomy-product.js'
import { RACCOON } from './raccoon-product.js'
import { ZcodeAuth } from './zcode-auth.js'
import { registerZcodeLlm } from './zcode-adapter.js'
import { ZCODE } from './zcode-product.js'
import { ZCODE_CAPTCHA_FALLBACK, type ZcodeCaptchaConfig } from './zcode-captcha.js'
import type { CarrierOutcome } from './captcha-carrier.js'
import { AccountPool } from './account-pool.js'
import { geminiFetchForAccount } from './gemini-proxy.js'
import { MultiAccountRefreshScheduler } from './refresh-scheduler.js'
import { hasLegacyNamespaceRegistration, settingsOf, suppressAutoSettingsPage } from './settings-compat.js'
import { DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES, type ImageRequestTarget } from './image-budget.js'
import { buildRaccoonNickname, registerJetHubRpc, type JetHubAuthLike } from './jet-hub-rpc.js'
// ⚠️ provider 接线层（架构审查 ⑨）：`apply()` 里 2000 行装配段搬到了
// `provider-wiring.ts`，此处只 import 那一个入口函数。
import { wireProviders } from './provider-wiring.js'
import { ALL_PRODUCTS, CODEBUDDY, WORKBUDDY } from './product.js'
import { mountOpenAiGateway } from './openai-gateway/index.js'
import { installLoopResume } from './loop-recovery.js'
import { installWebNative } from './web-native.js'
import {
  attachTokenLedgerStore,
  reportLedgerAccount,
} from './token-ledger.js'
import { createTokenLedgerStore } from './token-ledger-store.js'
import { BuddyBalanceSelector } from './buddy-balance-selector.js'
import { createCredentialResolver, NO_FREE_MODEL } from './credential-resolver.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { QODER, QODER_CN } from './qoder-product.js'
import { TRAE } from './trae-product.js'
import { CLINE } from './cline-product.js'
import { configureDeadModelStore, withDeadModelPruning } from './dead-model-store.js'
import type { CodeArtsCredential, BuddyCredential } from './types.js'
import type { LobsteraiCredential } from './lobsterai.js'
// ⚠️ astudio 的 `fetchAstudioCreditBalance` 是 2026-10-20 为「永久积分锁定」新增的
//    薄封装（压平 `fetchAstudioBalanceDetailed` 的 `{balance, error?}` 成
//    `CreditBalance | null`，因为 `BuddyBalanceSelector` 的 `fetchBalance` 契约
//    只要余额、不要原因）。**不要**在选号路径上直接调 Detailed —— 那会丢掉
//    「为什么查不到」的分流（会话失效 / 服务不可用 / 形状不认识）。
import { fetchAstudioCreditBalance } from './astudio-credits.js'
import type { QoderCredential } from './qoder.js'
import type { TraeCredential } from './trae.js'
import type { ClineCredential } from './cline.js'
import type { LoomyCredential } from './loomy.js'
// ⚠️ AutoClaw 两站（2026-10-21，用户要求「补锁定开关」）：`fetchAutoclawCreditBalance`
//    是 `fetchAutoclawBalanceDetailed` 的薄封装（压平 `{balance, error?}` 成
//    `CreditBalance | null`，因为 `BuddyBalanceSelector` 的 `fetchBalance` 契约
//    只要余额、不要原因）。**不要**在选号路径上改调 Detailed —— 那会在选号路径上
//    重写一套失败分类，与本文件「同义判据只留一处」的纪律冲突。
//    ⚠️ 它的第二参是 `options?: AutoclawCreditsOptions`（`{ product, fetcher? }`），
//    与 qoder 那份的 `(credential, product)` 位置顺序**不同**，别照抄。
import { fetchAutoclawCreditBalance } from './autoclaw-credits.js'
import type { RaccoonCredential } from './raccoon.js'
// ⚠️ MiniMax 国际站的**账号出口代理**解析器（与 gemini 同款：实例住在被依赖
//    方向的下游，避免 `index → jet-hub-rpc → index` 的 ESM 环 —— 那条环会把
//    引用变成 TDZ ⇒ 静默恒直连）。
//
// ⚠️ `minimaxIntlXffForProbe` 也住在那里（PR !145 审计 P1 修法）：初版在**本文件**
//    另开了一个 `globalThis.__jetHubMinimaxXffPool` 全局槽来给探测槽取 XFF ——
//    同一个「池在 `apply()` 才就绪」的问题，代理用模块级 ref、XFF 用全局槽，
//    两套机制。全局槽还有两个模块级 `let` 没有的代价：跨包副本串号
//    （两个路径的包各有一份模块实例，但 `globalThis` 共享）、以及 dispose 后
//    永不清理（`setMinimaxProxyPool(undefined)` 清不掉它）。
//    ⇒ 收敛到 `minimax-proxy.ts` 的同一个 `minimaxPoolRef`，与 gemini 逐格同构。
import { minimaxIntlFetchForAccount, minimaxIntlXffForProbe } from './minimax-proxy.js'
import { MINIMAX, MINIMAX_INTL } from './minimax-product.js'
// ⚠️ `PROVIDER_REGISTRY` 供 namespace 清单派生（`registerProviderSettings` 的实参）；
//    `descriptorOf` 供**能力注册表**逐项取元数据（见下面的注册段）。
//    brief 原稿称「Task 1 已加过 `descriptorOf`，合并进同一行」，实测**没有** ——
//    故 Task 2 才把它并进本行。
import { ACTIVE_PROVIDERS, descriptorOf, isChannelAllowed } from './provider-registry.js'
import { registerProviderRuntime, registerBalanceCache, expiryOf, runtimeOf, wiredRefreshTargets, type ProviderRuntime } from './provider-runtime.js'
// ⚠️ Task 8：探测适配器的**构造**从 `account-probe.ts` 搬到本文件（注册处）——
//    那里已改为查注册表，未登记则抛错（不再有 `else` 兜底交给 CodeArtsAdapter）。
//    ⇒ 这里需要**全部**会写 `modelRateLimits` 的适配器类（含 loomy / raccoon，
//    旧链漏了它们 = 同型缺陷第 5 次）。
//    ⚠️ **刻意不写「几家」**：本句原写「全部 **10 家**」，实测那只是**紧邻下面
//    这一段**导入的类数（10）—— 而 `OpencodeAdapter` 的导入在更下面的独立一行
//    （它同时供 `registerOpencodeLlm` 用），于是「会写标记的适配器类」实为 **11**；
//    按**家**展开则是「每个会写标记的家」（数字会随 provider 增减腐坏，别写）。
//    ⇒ 权威清单与判据见 `probeById` 自己的头注释，别在这里写数字。
import { BuddyAdapter } from './buddy-adapter.js'
import { LobsteraiAdapter } from './lobsterai-adapter.js'
import { QoderAdapter } from './qoder-adapter.js'
import { ClineAdapter } from './cline-adapter.js'
import { ZcodeAdapter } from './zcode-adapter.js'
import { TraeAdapter } from './trae-adapter.js'
import { CodeArtsAdapter } from './llm-adapter.js'
import { GeminiAdapter } from './gemini-adapter.js'
import { LoomyAdapter } from './loomy-adapter.js'
import { MinimaxAdapter } from './minimax-adapter.js'
import { RaccoonAdapter } from './raccoon-adapter.js'
// ===== Accio（阿里）=====
// ⚠️ `AccioAuth` / `AccioAdapter` / `ACCIO` 与其余 provider **平行而非继承**：
//    它的信封是 Gemini 风格（snake_case）、token 在 **body**（放 Authorization
//    头恒流内 402）、且**不需要** SecurityGuard 签名（实测不带 `pctb-x-*` 同样 200）。
//    详见 `docs/agent-notes/providers-accio.md`。
import { AutoclawAuth } from './autoclaw-auth.js'
import { registerAutoclawLlm } from './autoclaw-adapter.js'
import { AUTOCLAW, AUTOCLAW_INTL } from './autoclaw-product.js'
import { isAutoclawUuidUserId, type AutoclawCredential } from './autoclaw.js'
import { AccioAuth } from './accio-auth.js'
import { AccioAdapter, registerAccioLlm } from './accio-adapter.js'
import { ACCIO } from './accio-product.js'
import type { AccioCredential } from './accio.js'
// AStudio（讯飞 AstronStudio）：直连上游 MAAS。**没有 OAuth 授权页** —— 推理凭据是
// 本机客户端登录后明文落盘会话的一份拷贝（见 astudio-auth.ts 模块头）。
// 本家符号分属四个模块：auth 服务在 astudio-auth.ts、适配器注册在 astudio-adapter.ts、
// 产品常量在 astudio-product.ts、纯函数与凭据类型在 astudio.ts。
import { AstudioAuth } from './astudio-auth.js'
import { registerAstudioLlm } from './astudio-adapter.js'
import { ASTUDIO } from './astudio-product.js'
// ⚠️ 类型必须在**类型位置**导入：`verbatimModuleSyntax` 下漏了它会在
//    `resolveAstudioCredentialByRef` 的返回标注处报 TS2552（2026-10-20 实测）。
import type { AstudioCredential } from './astudio.js'
// ⚠️ **本 fork 独有**的 provider（上游 rc.11 仍无 modelscope）。
// 见 `docs/agent-notes/providers-modelscope.md` 与 `src/modelscope-product.ts` 模块头的逐条出处表。
import { ModelscopeAuth } from './modelscope-auth.js'
import { ModelscopeAdapter, registerModelscopeLlm } from './modelscope-adapter.js'
import { MODELSCOPE } from './modelscope-product.js'
import { modelscopeModelsUrl, modelscopeHeaders, type ModelscopeCredential } from './modelscope.js'
import type { ZcodeCredential } from './zcode.js'
import { GEMINI_DEFAULT_PROJECT, GEMINI_SESSION_LANE_SMOKE } from './gemini.js'
import { createProviderCredits, creditsOf } from './provider-credits.js'
import { createProviderOnboarding, onboardingOf } from './provider-onboarding.js'
import type { MinimaxCredential } from './minimax.js'
import { GeminiAuth } from './gemini-auth.js'
import { registerGeminiLlm } from './gemini-adapter.js'
import { GEMINI } from './gemini.js'
// OfficeAce（华为 ModelArts MaaS 云端直连）：适配器 + 产品配置 + 鉴权模块
//（登录 / 推理 / 续期 / 余额 / 倍率全部直连云端，**不依赖 OfficeAce 客户端**）。
import { registerOfficeAceLlm } from './officeace-adapter.js'
import { OFFICEACE } from './officeace-product.js'
import * as officeaceAuth from './officeace-auth.js'
// Codely（Unity 团结引擎）：目录 + 推理都已接通（推理 2026-10-20 起走 HTTP
// 自签直连，`codely-sign.ts`；`CodelyAdapter` 同时供 `probeById` 探测用）。
import { CodelyAdapter, registerCodelyLlm } from './codely-adapter.js'
import { CODERLY } from './codely-product.js'
import { CODELY_PROVIDER_ID, readCodelyCredential, type CodelyCredential } from './codely-auth.js'
// 「锁定永久积分」在 officeace 上的**唯一执行实现**（issue IKLTHB 第 ① 条：
// 该渠道登记了 `permanentLock: true`，而原先全仓没有任何代码读这张锁定表）。
import { createOfficeAceCredentialProvider } from './officeace-lock.js'
import type { GeminiCredential } from './gemini.js'
import { createGeminiSigStore } from './gemini-sigstore.js'
import { OpencodeAdapter, registerOpencodeLlm } from './opencode-adapter.js'
import { AUTO_PROVIDER, registerAutoLlm } from './auto-adapter.js'
// ⚠️ `createExpiryProbe` 从**底座**导入，不是从 `aggregate-adapter.js`
//（它定义在 `aggregate-expiry.ts`，理由见该文件与 Task 7 的 Files 说明）。
import { createExpiryProbe } from './aggregate-expiry.js'
// ⚠️ 共享余额读数缓存（2026-10-15，规格 §5.7）：装配层建**一个**实例，
//    `credits.balances` 端点与 buddy 系四家的折算共用它（见下面 `balanceCache` 的长注释）。
import { createBalanceCache, createBalanceRefresher, REFRESH_PERIOD_FALLBACK_MS, type BalanceCacheEntry } from './balance-cache.js'
// ⚠️ 模型目录的后台刷新器（用户 2026-10-18 要求：20 分钟定时更新）。
//    与余额刷新器**共用同一套骨架**（武装 + 单飞 + 幂等），但**不复用实例** ——
//    余额缓存 key 是 `(provider, accountId)`、目录的 key 是 provider，语义不同。
import { createCatalogRefresher } from './model-catalog.js'
// ⚠️ 中止判据复用适配器的**共享实现**（`aggregate-adapter.ts` 的 `isAbortLike`）：
//    本仓库已有 4 份同义实现，装配层不该再添第五份。
import { isAbortLike as isAbortLikeError } from './abort-like.js'
import { createProviderExpiry } from './provider-expiry.js'
// ⚠️ opencode 的 RPC 由 `jet-hub-rpc.ts` 的 handleMethod 统一分派
// （它调 handleOpencodeRpc），本文件**不再**单独注册端点 —— 详见
// `opencode-rpc.ts` 模块头「为什么是被主 switch 调用」。
import {
  ensureDefaultAnonymousSlot, listIdentitySlots, poolEntrySnapshot,
} from './opencode-auth.js'
import { OPENCODE } from './opencode-product.js'
import type { OpencodeCredential } from './opencode.js'
import { MODELS_DEV_TTL_MS, primeModelsDev, refreshModelsDev } from './models-dev-cache.js'
import { invalidateOpencodeCapabilities } from './opencode-capability.js'
import { closeAllProxyDispatchers } from './opencode-proxy.js'
import { execFile } from 'node:child_process'

/**
 * 懒加载的 OpenCode UA：首个请求要发时才探测本机 opencode 版本，探测一次即缓存。
 *
 * ⚠️ 拿不到**不阻塞、不抛错**，回退 `OPENCODE.defaultUserAgent`：UA 只是一个伪装
 * 维度，服务端并未校验其真实性（opencode2dsh 实测），不值得为此延迟启动。
 * 探测最多等 2 秒；本机没装 opencode 是**正常情况**（匿名通道照样能用）。
 * ⚠️ 用 `execFile` 而非 `exec`：**不经过 shell**，参数不会被解释；带
 * `windowsHide` 免得在 Windows 上闪一个黑框。
 * ⚠️ 缓存 Promise 而非结果：并发首请求只会 spawn 一次探测进程。
 */
function lazyOpencodeUserAgent(): () => string {
  let pending: Promise<string> | undefined
  return () => {
    pending ??= new Promise<string>((resolve) => {
      execFile('opencode', ['--version'], { timeout: 2000, windowsHide: true }, (_err, stdout) => {
        resolve(typeof stdout === 'string' ? stdout : '')
      })
    })
      .then((out) => {
        const version = out.match(/(\d+\.\d+\.\d+)/)?.[1]
        return version === undefined ? OPENCODE.defaultUserAgent : `opencode/${version}`
      })
      .catch(() => OPENCODE.defaultUserAgent)
    // 同步取值：缓存命中时立刻有值；未命中时用产品默认（不阻塞首个请求）。
    let cached = OPENCODE.defaultUserAgent
    void pending.then((ua) => { cached = ua })
    return cached
  }
}

/**
 * 拉取 Zen 模型目录的超时（毫秒）。
 *
 * ⚠️ 桌面版实测：到 `opencode.ai` 的 fetch 可能**永不 settle**（宿主网络
 * 异常），而 `loadOpencodeCatalog` 的兜底分支只有在内层 Promise **结束**
 * 后才可能执行。挂死时模型列表与用量徽标会同时空白（用户报障 2026-10-02）。
 * 8 秒足够覆盖正常路径（实测首字节 720ms 量级），又不会让 UI 干等太久。
 */
const OPENCODE_CATALOG_TIMEOUT_MS = 8_000

export const name = 'codearts-auth'
// `connection` 刻意不列入静态 inject：它只由 Web bundle（dsh-client-connection）
// 提供，headless/CLI profile 里并不存在。静态 inject 会让本插件在那些 profile
// 里永久 pending，进而让整个 profile 以
// "plugin tree failed to load: 1 entry did not activate" 启动失败
// —— chicheng-cron 的 skill/agent 任务正是通过 `dsh --profile headless` 运行的，
// 会因此全部 exit 1。大肥鱼饭碗 的 RPC 端点在 Web 下通过 apply 内的可选注入挂载，
// 其余 profile 只是不注册该端点。
export const inject = ['credentials', 'llm']

/**
 * 插件 Config schema。
 *
 * ⚠️ **DSH 0.1.7-rc.1 起，settings 表单的命名空间就是 profile 条目 id**
 * （本插件的条目 id 是 `codearts-auth`），且只投影本条目 Config 中标记了
 * `.volatile()` 的字段。因此这里保留一个 `providers` 映射：
 * - **历史**：它曾是各 provider 用 `registerConfigurableProviders({ settingsNs })`
 *   声明时的落地位置，模型设置页据此把它们判定为「已配置」（判据见
 *   `dsh-client-ui-settings-models` 的 `configured`）。**2026-10-01 起本插件不再
 *   声明可配置 provider**（见 `llm-register-compat.ts` 模块头），该映射因此没有
 *   消费者，保留它只为不改变 `settings.describe()` 的既有形状；
 * - 本插件的凭据与账号管理**不**走这里（那是 大肥鱼饭碗 的账号池 +
 *   `ctx.credentials`），故该字段只承接一个宽松映射，不参与业务读取。
 *
 * 必须是 schemastery schema：`SettingsForms.describe()` 会对每个注册项调用
 * `schema.toJSON()`，传入裸函数（`(value) => ...`）会让它抛
 * `TypeError: ... .toJSON is not a function`，进而使所有依赖 settings 的界面
 * （模型设置页、sidebar 的 settings.get/shell.get）全部失败。
 */
export const Config = Schema.object({
  providers: Schema.dict(Schema.any()).default({}).volatile(),
})

/**
 * 注册 provider 配置 namespace（**仅老契约需要**）。
 *
 * - **≤0.1.6**：`ctx.settings` 允许插件注册任意 namespace，六个 provider 各占
 *   一个（`llm-buddy` / `llm-workbuddy` / ...）。注册缺失会让模型设置页在
 *   `refFor → deriveKeyRef(provider)` 处以
 *   `provider.toUpperCase is not a function` 崩溃，故注册后回读 `describe()` 自检。
 * - **0.1.7-rc.1**：settings 换成 `SettingsForms`，**没有 `register`**，命名
 *   空间只能是 profile 条目 id —— 此时不再（也无法）注册。这里刻意**静默跳过**：
 *   旧实现在这条分支上会打一条误导性的
 *   「settings 服务不可用」告警（启动日志实证）。
 *
 * ⚠️ **2026-10-01 起各 provider 不再声明为可配置 provider**（`settingsNamespaceFor`
 * 因此没有调用方），模型设置页不再有这些 namespace 的消费者 —— 这份注册此后只影响
 * ≤0.1.6 的老契约 profile，属遗留行为，本次未一并删除。
 */
function registerProviderSettings(ctx: Context, ...namespaces: string[]): void {
  const settings = settingsOf(ctx)
  if (!hasLegacyNamespaceRegistration(settings) || settings?.register === undefined) return
  for (const ns of namespaces) {
    try {
      settings.register(ns, Config)
    } catch (error) {
      ctx.logger.warn(`[codearts-auth] settings namespace "${ns}" 注册失败: ${String(error)}`)
    }
  }
  // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
  // 注意：describe() 会遍历所有已注册 namespace 并调用各自 schema 的
  // toJSON()/redactSecrets()，任一注册项的 schema 不合规都会让整条调用抛错。
  // 因此这里必须把异常打出来，而不是静默吞掉。
  try {
    const descriptors = settings.describe?.({ redactSecrets: true }) ?? []
    const registered = descriptors.map(v => v.ns)
    const missing = namespaces.filter(ns => !registered.includes(ns))
    if (missing.length > 0) {
      ctx.logger.warn(`[codearts-auth] provider namespace 未生效: ${missing.join(', ')}`)
    }
    ctx.logger.info(`[codearts-auth] settings.describe ok, namespaces: ${registered.join(', ')}`)
  } catch (error) {
    ctx.logger.error(
      `[codearts-auth] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: `
      + `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    )
  }
}

/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 *
 * 用 `ctx.get` 而非 `inject` —— 附件服务缺失时 provider 仍可正常加载，

 * 只是收到图片时报 UNSUPPORTED_CONTENT。三个 provider 共用本实现：
 * 两个 CodeBuddy 系产品（CodeBuddy / WorkBuddy）共用同一后端与协议；
 * LobsterAI 的图片形态同为 OpenAI 兼容的 `image_url` data URL
 * （2026-09-17 实测服务端接受并正确识别内容）。

 */
export function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string }> => {
    const attachments = ctx.get('attachments') as
      { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> } | undefined
    if (attachments?.readImage === undefined) {
      throw new Error(
        'codearts-auth: 附件服务（attachments）不可用，无法把图片内联进请求；'
        + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local。',
      )
    }
    const stored = await attachments.readImage(attachment as never)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }
}

/**
 * 图片「请求版本」桥接（issue !IKITT9）。
 *
 * 走 `ctx.attachments.readImageRequest(ref, target)`：由附件服务按目标尺寸与
 * 字节目标产出**确定性、可缓存**的缩放版本（alpha 走 WebP、不透明走 JPEG、
 * 85/75/60 质量阶梯），适配器只负责选目标。
 *
 * ⚠️ **任何不可用都返回 `undefined`，绝不抛错**，调用方据此回退原图。三种
 * 真实成因都必须容忍，否则「加上缩放」本身会变成新的故障源：
 *
 * 1. 宿主 profile 没装附件服务，或该版本没有 `readImageRequest`（老契约）；
 * 2. 附件后端明确拒绝投影（`ATTACHMENT_PROJECTION_UNSUPPORTED`）；
 * 3. 派生过程中的其它错误（缓存不可写、字节校验失败…）。
 *
 * 回退方向是刻意选 conservative 的一侧：宁可发一张大图（顶多触发网关的
 * 图片 token 上限），也不能因为「想缩图」而把一次本来能成功的请求打死。
 */
export function makeReadImageRequest(ctx: Context) {
  return async (
    attachment: unknown,
    target: ImageRequestTarget,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> => {
    const attachments = ctx.get('attachments') as {
      readImageRequest?: (
        ref: never,
        requestTarget: never,
      ) => Promise<{ data: Uint8Array; mediaType?: string; attachment?: { mediaType?: string } }>
    } | undefined
    if (attachments?.readImageRequest === undefined) return undefined
    try {
      const projected = await attachments.readImageRequest(attachment as never, target as never)
      const mediaType = projected.mediaType ?? projected.attachment?.mediaType
      if (mediaType === undefined) return undefined
      return { data: projected.data, mediaType }
    } catch (error) {
      // 只记日志、随后回退原图：缩放是优化，不是请求的前置条件。
      ctx.logger?.warn?.(
        '[jet-hub] 图片请求版本派生失败，回退原图：'
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
}

/**
 * **AutoClaw 存量账号自愈**：先补齐 `user_id`，再按它去重。
 *
 * ## 为什么要「先补齐」（两轮失败才换来这一步）
 *
 * 用户三次报障「同一账号被加了 3 次」。实测三条凭据的字段形态**不一致**：
 *
 * | ref | 凭据 `user_id` | JWT `user_id` | JWT `guid` |
 * |---|---|---|---|
 * | `A6539467` | —（无该字段） | `839684` | `""`（空串） |
 * | `D6BF9EB2` | —（无该字段） | `839684` | `""`（空串） |
 * | `A3C56DD6` | `7c54a9a…`（UUID） | `839684` | `""`（空串） |
 *
 * 即存在两个**互不相通**的 id 空间：
 *
 * - **UUID**（`7c54a9acc…`）= 账号主键，服务端 `user-profile` 与凭据字段都用它；
 * - **`numericUserId`**（`839684`）= JWT 的 `user_id`，纯数字。
 *
 * 「字段优先、JWT 兜底」会让前两条落到 `839684`、第三条落到 UUID
 * ⇒ **分裂成两组、一条都去不掉**（用户二次报障「怎么还是在啊」的直接原因）。
 *
 * ## 定稿做法
 *
 * 1. 逐条 ref 调 `POST /userapi/v1/user-profile`（实测三条都拿回同一个 UUID），
 *    把 `user_id` **写回凭据**；
 * 2. 补齐后全池统一按 `user_id` 分组去重（`dedupeByCredentialField`）。
 *
 * ⚠️ 全程**尽力而为**：单条补齐失败只跳过该条、记 warn，绝不让启动失败。
 * ⚠️ 网络请求按 8s 超时，N 条串行最坏 N×8s —— 但它是 `void` 起的，
 *    不阻塞插件启动，也不阻塞用户第一条消息。
 */
async function autoclawSelfHeal(
  pool: AccountPool,
  ctx: Context,
): Promise<void> {
  // ⚠️⚠️ **读池本身也会抛**（2026-10-20 合并审计补记，实测有牙）：
  //    `AccountPool.listAccountsByProvider()` → `readAccounts()` → `ensureLoaded()`
  //    → `SettingsStore.load()` 在 scope 尚未就绪时抛 `TypeError`。原先只有
  //    **per-条目** 的 try 包住循环体，读池这一句在 try **之外** ⇒ 一抛就是
  //    **未捕获 rejection**（Node 默认 `--unhandled-rejections=throw`），
  //    全量单测实测 52 条 `Unhandled Rejection`。
  //    自愈是**尽力而为**：任何失败都只能记 warn，绝不能让启动失败。
  let entries: ReturnType<AccountPool['listAccountsByProvider']>
  try {
    entries = pool.listAccountsByProvider('autoclaw')
  } catch (error) {
    ctx.logger?.warn?.(
      `[autoclaw] 账号自愈读池失败（不影响启动）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  if (entries.length < 2) return

  // ── ① 补齐 user_id（只补缺的那条）──
  for (const entry of entries) {
    try {
      const raw = await ctx.credentials.resolve(credentialRef(entry.credentialRef))
      if (raw === undefined || raw.value.length === 0) continue
      const cred = JSON.parse(raw.value) as {
        access_token?: unknown
        device_id?: unknown
        user_id?: unknown
      }
      // ⚠️⚠️ **跳过条件必须是「已经是 UUID」，不能是「有值」**
      //    （2026-10-20 审计 P1，实测真缺陷）。
      //
      //    登录路径用 `readUserIdFromJwt()` 写回的 `user_id` 是**字符串形态的
      //    数字 id**（`String(839684)` ⇒ `"839684"`），原判据
      //    `typeof === 'string' && trim() !== ''` 对它**恒真** ⇒ 自愈从不为
      //    PR 之后新登录的账号补 UUID ⇒ 池里永久并存 `autoclaw:839684` 与
      //    `autoclaw:7c54a9a…` 两组 ⇒ 去重对混合池无效（PR 要修的症状原样存在）。
      //
      //    ⇒ 只有「已经是 UUID 主键」才算补齐完成。
      if (isAutoclawUuidUserId(cred.user_id)) continue

      const token = typeof cred.access_token === 'string' ? cred.access_token : ''
      const device = typeof cred.device_id === 'string' ? cred.device_id : ''
      if (token === '' || device === '') continue

      const ts = Math.floor(Date.now() / 1000).toString()
      const sign = createHash('md5').update(`${AUTOCLAW.appId}&${ts}&${AUTOCLAW.appKey}`).digest('hex')
      const resp = await fetch(`${AUTOCLAW.apiBase}/userapi/v1/user-profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Appid': AUTOCLAW.appId,
          'X-Auth-TimeStamp': ts,
          'X-Auth-Sign': sign,
          'X-Lang': 'zh-CN',
          'X-Channel': 'official',
          'Authorization': `Bearer ${token}`,
          'X-Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ source_id: 'autoclaw', device_id: device }),
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) {
        ctx.logger?.warn?.(
          `[autoclaw] 账号 ${entry.id} 补齐 user_id 失败（HTTP ${resp.status}），跳过该条`,
        )
        continue
      }
      const json = (await resp.json()) as { code?: number; data?: { user_id?: unknown } }
      const userId = json.data?.user_id
      if (json.code !== 0 || typeof userId !== 'string' || userId.trim() === '') {
        ctx.logger?.warn?.(
          `[autoclaw] 账号 ${entry.id} 补齐 user_id 失败（code=${json.code}），跳过该条`,
        )
        continue
      }
      // ⚠️ 只改 `user_id` 一个键，其余凭据字段原样保留
      //    （access_token/refresh_token/device_id 一个字节都不能动）。
      await ctx.credentials.set(
        credentialRef(entry.credentialRef),
        JSON.stringify({ ...cred, user_id: userId.trim() }),
      )
      ctx.logger?.info?.(
        `[autoclaw] 账号 ${entry.id} 已补齐 user_id（${userId.trim().slice(0, 8)}…）`,
      )
    } catch (error) {
      ctx.logger?.warn?.(
        `[autoclaw] 账号 ${entry.id} 自愈异常（不影响启动）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // ── ② 按补齐后的 user_id 去重 ──
  // ⚠️ **不再给兜底解析器**：此时所有 ref 都应当有 UUID，
  //    若有（网络全失败），跳过总比误删好。
  const removed = await pool.dedupeByCredentialField('autoclaw', 'user_id')
  if (removed > 0) {
    ctx.logger?.warn?.(
      `[autoclaw] 已清理 ${removed} 条重复账号（同一账号被重复添加导致积分累加翻倍）`,
    )
  }
}

/**
 * 「重测」用的**探测适配器工厂**（Task 8）。
 *
 * ⚠️ 各家代码**逐字**从 `src/account-probe.ts` 的 `else if` 链搬来（含各自的
 * 注释）；那条链已删除，改为查本表（**未登记 ⇒ 抛可读错误**）。
 *
 * ## 谁必须在这里
 *
 * 判据是「该 provider 的适配器会不会写 `modelRateLimits`」（写了才有重测语义）。
 * 核对方式机械、不要靠记忆：
 *
 *     grep -n 'updateModelRateLimit(' src/*.ts        # 写点（池侧定义 + 各适配器直调）
 *     grep -n 'markLimited' src/*.ts                  # 适配器侧经回调注入的写点
 *
 * ⚠️ **两条都要跑**：实测多数适配器是**直调** `pool.updateModelRateLimit(...)`
 * （只有 `cline` / `opencode` 用 `markLimited` 这个名字），只看第二条会把
 * 大部分家漏掉。
 *
 * ⚠️ **不要在这里抄名单、也不要写「几家」**：本段曾写「会写标记的 provider 共
 * **13 家**」并紧跟 13 个名字，2026-10-11 加入 `minimax`（issue IKJW32）后当场过期
 * —— 这正是本文件自己记的「同一条事实的多份抄写必然漂移」的又一次实证。
 * 权威判据是上面那两条 grep；权威清单是 `tests/helpers/provider-sets.ts` 的
 * `WRITES_RATE_LIMIT_PROVIDERS`（守卫把它与源码写点**双向**比对，
 * 漏一家 / 多一家都点名变红）。本表必须**恰好**登记那份清单里的家。
 *
 * 登记史（只记形态、不记数字）：
 *
 * - **第 5 次** `loomy` / `raccoon`：旧 `else if` 链里**没有它们的分支** ⇒ 落入
 *   `else` 被交给「华为云 HMAC 签名」的 `CodeArtsAdapter`，而它们的限流标记
 *   （UTC+8 当日 24:00）**永远清不掉**。
 * - **第 6 次** `opencode`：不是漏项，而是「登记表刻意豁免了它」且**理由被证伪**。
 * - **第 7 次** `minimax`：它先前**确实**不写标记（14 家里唯一），故曾被判
 *   「不需要 probe」；2026-10-11 接上请求级换号 + 冷却后该前提作废。
 *   ⇒ 判据永远是「**现在**写不写标记」，不是「曾经写不写」。
 *
 * ⚠️⚠️ **不要再写「`opencode` 不写标记」**（2026-10-08 原注释如此，独立复审
 * 实测证伪）：它与「余额是本地派生的通道可用性、零网络」说的是**两件事** ——
 * 后者是它不进积分表的理由（见 `provider-credits.ts`），前者是它进不进出本表的
 * 判据。把前者当成后者的推论，恰好把一个**真实的漏挂**说成了「不需要」。
 *
 * ⚠️ **UI 入口**：`jet-hub.js` 里「重测所有」/「重置所有」/卡片级「重测」「重置」
 * 都由 `supportsRateLimit(provider)` 门控（缺省 **true**），**不是**
 * `accountTest`（那是另一个「测试」按钮的位）。原注释称「`accountTest` 只有
 * `gemini` 为 true ⇒ 其余渠道没有入口」—— **该推论是错的**：`opencode` 没有
 * `rateLimit: false` 豁免 ⇒ 这些按钮**会渲染**。
 * ⇒ 本表的完整性**已经是用户可见功能**，不是「将来才复发」的内部契约
 * （只有「测试」那一个按钮仍限 `gemini`）。
 *
 * ⚠️ 一致性与「漏一家」由 `tests/unit/provider-runtime-wiring.spec.ts` 的 probe
 * 域守卫从硬编码清单 + {@link PROBE_EXEMPT} 派生锁死（漏挂会让它**点名**变红）。
 */
export const probeById: Record<string, NonNullable<ProviderRuntime['probe']>> = {
  // CodeBuddy 系（buddy / workbuddy）→ BuddyAdapter，按各自 product 发请求。
  buddy: {
    createProbeAdapter: (ref, credential) => new BuddyAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as BuddyCredential,
      refresh: async () => {},
      product: CODEBUDDY,
    }),
  },
  workbuddy: {
    createProbeAdapter: (ref, credential) => new BuddyAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as BuddyCredential,
      refresh: async () => {},
      product: WORKBUDDY,
    }),
  },
  // LobsterAI → 自己的端点与头族。
  lobsterai: {
    createProbeAdapter: (ref, credential) => new LobsteraiAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as LobsteraiCredential,
      refresh: async () => {},
      product: LOBSTERAI,
    }),
  },
  // Qoder 国际版与中国版**共用同一个适配器类**，差异全在 product 配置里
  //（区域端点、client_id、模型表）。探测只发一次最小纯文本请求，不涉及
  // 工具/图片，故除了 product 之外无需注入其它钩子；`uid` 由凭据自身携带
  //（旧凭据缺 uid 时适配器会明确报错，而不是发出必然失败的请求）。
  qoder: {
    createProbeAdapter: (ref, credential) => new QoderAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as QoderCredential,
      refresh: async () => {},
      product: QODER,
    }),
  },
  qodercn: {
    createProbeAdapter: (ref, credential) => new QoderAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as QoderCredential,
      refresh: async () => {},
      product: QODER_CN,
    }),
  },
  // Cline → WorkOS 凭据 + 自己的端点。
  cline: {
    createProbeAdapter: (ref, credential) => new ClineAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as ClineCredential,
      refresh: async () => {},
      product: CLINE,
    }),
  },
  // ⚠️ **本 fork 独有**（modelscope，2026-10-16）。
  //
  // 探测只发一次最小请求（`probe` 走适配器的 `listModels` / 一次最小补全），
  // 故只需把**这一份凭据**喂进 `slots`（单槽），不需要池 —— 与 cline 同款。
  // ⚠️ `fetchRemoteCatalog` 留空：目录探测不是「探活」的职责，
  //    且它会在 `listModels` 里回退兜底表（不会抛）。
  modelscope: {
    createProbeAdapter: (ref, credential) => new ModelscopeAdapter({
      credentialRef: credentialRef(ref),
      slots: async () => [{ id: MODELSCOPE.id, apiKey: (credential as ModelscopeCredential).access_token }],
      product: MODELSCOPE,
      // ⚠️ 不传 `warn`：`probeById` 是**模块级**常量（在 `apply()` 之前求值），
      //    此处**没有 `ctx`**。与 cline / lobsterai 的 probe 条目同款。
    }),
  },
  // ZCode（智谱）→ Anthropic Messages 体 + 阿里云 captcha 参数。
  //
  // ⚠️ 已知取舍：探测路径**没有** `mintCaptcha` 透传通道（`ProbeDeps` 里没有
  // 这一项），故**一旦上游索要验证**，这里的适配器就**自建**一个常驻浏览器
  //（上游不要验证时压根不 mint，也就不会拉）。若宿主里已有 `index.ts`
  // 注入的那台（`zcode.mintCaptcha`），短时会并存两台（约 200MB/台）。
  // 这仍然远好于旧缺陷的形态 —— 落 else 会被交给**华为云 HMAC 签名**的
  // `CodeArtsAdapter` 去发 zcode 凭据，探测必然失败，而 zcode 的额度标记
  //（UTC+8 当日 24:00）会一直清不掉。
  // 后续若要消除这层浪费，应给 `ProbeDeps` 加一条 `mintCaptcha` 透传，
  // 与 `index.ts` 的 `zcode.mintCaptcha` 共用同一台常驻浏览器。
  zcode: {
    createProbeAdapter: (ref, credential) => new ZcodeAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as ZcodeCredential,
      refresh: async () => {},
      product: ZCODE,
    }),
  },
  // TRAE → SOLO 格式请求体 + Cloud-IDE-JWT 头族。
  // 只有一个产品（`TRAE` 常量），没有 productById 式的查表，故直接按 id 注册。
  // 不传 product → TraeAdapter 内部默认用 TRAE。
  trae: {
    createProbeAdapter: (ref, credential) => new TraeAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as TraeCredential,
      refresh: async () => {},
    }),
  },
  // Gemini（Cloud Code Assist）。
  //
  // 探测只发一次最小纯文本请求，不涉及图片/工具，故除 product 与 lane 外
  // 无需其它钩子。
  //
  // ⚠️ lane 必须是 `smoke`：原版实测冒烟路径与推理路径的 sessionId **不同**
  //（同 prompt 同预算下取值不同，说明 lane 进了哈希）。不传会让探测流量与
  // 真实推理混进同一个会话，污染会话归并与 thoughtSignature 回填。
  //
  // ⚠️ `project` **显式钉兜底串**，与「刻意不传 accountPool / fetchRemoteModels」
  // 同一个理由：探测是**轻量存活检查**，要的是一次到推理端点的真请求。
  // 若走自动探测，会先多打一次 `loadCodeAssist`，且 LCA 失败（限流/网络抖动）
  // 会让探测报「项目号探测失败」而不是它真正要报的「账号仍受限」—— 反而掩盖
  // 了用户点「重测」想知道的答案。探测**不写**任何东西（不传 persistProject）。
  gemini: {
    // ⚠️ **第三个形参 `entry` 不能丢**（IKLTZ2 审计 P1-1，真实缺陷）：
    // 探测路径**刻意不传 `accountPool`**（`account-probe.ts` 的既定语义：
    // 只测这一个账号、且不写任何标记）⇒ 适配器内那条「按 access_token 反查
    // 账号 id」的路**根本不存在** ⇒ 出口解析器拿到空 id、按「直连」处理
    // ⇒ **该账号的代理被完全绕过**。
    // 症状与 issue 原话同形：墙外环境下「测试 / 重测」**恒失败**，而这个失败
    // 与「账号已失效」在 UI 上完全同形 ⇒ 用户会去误删好号。
    //
    // ⚠️ 对照 opencode 的 `(ref, credential, entry)`（下方 L649）：它接下了
    // entry 并把 `entry.opencodeProxy` 喂进槽里，本家原先漏了这一步。
    createProbeAdapter: (ref, credential, entry) => new GeminiAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as GeminiCredential,
      refresh: async () => {},
      sessionLane: GEMINI_SESSION_LANE_SMOKE,
      project: GEMINI_DEFAULT_PROJECT,
      product: GEMINI,
      // ⚠️ **探测必须走该账号的代理**：账号卡片上的「测试 / 重测」按钮打的是
      // 真实推理端点，而 Gemini 全部端点都在墙外。
      fetchFor: geminiFetchForAccount,
      accountIdOverride: entry?.id ?? '',
    }),
  },
  // CodeArts → 华为云 HMAC 签名（**它自己的**签名方案，不是「兜底」）。
  // ⚠️ 旧实现里它是 `else` 的兜底分支 —— 那正是缺陷根源。现在它必须
  // **显式登记**，未登记的 provider 不再被静默交给它。
  codearts: {
    createProbeAdapter: (ref, credential) => new CodeArtsAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as CodeArtsCredential,
      refresh: async () => {},
    }),
  },
  // Loomy（讯飞）→ 自己的端点。⚠️ 旧链**漏了它**（第 5 次同型缺陷，见上）。
  loomy: {
    createProbeAdapter: (ref, credential) => new LoomyAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as LoomyCredential,
      refresh: async () => {},
      product: LOOMY,
    }),
  },
  // Raccoon Work（商汤小浣熊）→ 自己的端点。⚠️ 旧链**漏了它**（同第 5 次）。
  raccoon: {
    createProbeAdapter: (ref, credential) => new RaccoonAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as RaccoonCredential,
      refresh: async () => {},
      product: RACCOON,
    }),
  },
  // MiniMax Code（中国版）→ Anthropic Messages 端点。
  //
  // ⚠️ 它**曾经**不必在这里（issue IKJW32 之前：适配器不写 `modelRateLimits`）。
  // 2026-10-11 接上请求级换号 + 冷却后它**会写**标记（额度 24h / 限流 1h）
  // ⇒ 必须登记，否则标记写进去却永远清不掉 —— 与上面 `opencode` 完全同型。
  // 探测**不传** `fetchRemoteModels` / `accountPool` / `readImage`：与其余家同一
  // 理由（探测是轻量存活检查，不写任何状态、也不为一次探测额外拉目录）。
  // ⚠️ 尤其**不传 `accountPool`**：那会让 `stream()` 的反查与轮换在探测路径上
  // 复活（探测失败若写回限流标记，会把「重测 A 账号」变成污染池的副作用）。
  minimax: {
    createProbeAdapter: (ref, credential) => new MinimaxAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as MinimaxCredential,
      refresh: async () => {},
      product: MINIMAX,
    }),
  },
  // MiniMax Code 国际版 —— 与中国版同因（它同样会写 `modelRateLimits`），
  // 只是 product 换成 `MINIMAX_INTL`（探测请求必须打到 `agent.minimax.io`，
  // 否则国际站账号的「重测」会用国内站主机发凭据、必然 401 ⇒ 标记永远清不掉）。
  //
  // ⚠️⚠️ **国际站的探测必须走该账号的出口**（第三个形参 `entry` 不能丢）：
  // 探测路径**刻意不传 `accountPool`**（`account-probe.ts` 的既定语义：只测
  // 这一个账号、且不写任何标记）⇒ 适配器内那条「按 access_token 反查账号 id」
  // 的路**根本不存在** ⇒ 出口解析器拿到空 id、按「直连」处理 ⇒ **该账号的代理
  // 被完全绕过**。症状与报障同形：国际站「测试 / 重测」恒失败，而这个失败与
  // 「账号已失效」在 UI 上完全同形 ⇒ 用户会去误删好号（与 Gemini 的
  // `accountIdOverride` 是同一个缺陷形态）。
  minimaxintl: {
    createProbeAdapter: (ref, credential, entry) => new MinimaxAdapter({
      credentialRef: credentialRef(ref),
      resolveCredential: async () => credential as MinimaxCredential,
      refresh: async () => {},
      product: MINIMAX_INTL,
      fetchFor: minimaxIntlFetchForAccount,
      accountIdOverride: entry?.id ?? '',
      // ⚠️ 探测**无池** ⇒ `send()` 里从池读 `minimaxXff()` 那条腿恒空 ⇒
      //    用户设好的 XFF 在「测试 / 重测」上不生效，大陆出口的探测恒
      //    307 → 401（与「凭据失效」同形；2026-10-24 活体实测）。
      //    这里显式带上池的当前值（只读，不违反「探测不写状态」）。
      //    ⚠️ probeById 是**模块级常量**（`pool` 在 `apply()` 里才存在），
      //    故经可后填的取值函数现读（与 `minimaxIntlFetchForAccount` 同一模式），
      //    池未就绪时返回 undefined = 不附 XFF（与既有行为一致）。
      xffOverride: minimaxIntlXffForProbe(),
    }),
  },
  // Accio（阿里）→ 自己的网关端点。
  //
  // ⚠️ 它**曾经**不必在这里（issue IKM3ZV 之前：适配器不写 `modelRateLimits`，
  // `provider-registry.ts` 的 `rateLimit: false` 与 `WRITES_RATE_LIMIT_PROVIDERS`
  // 都据此把它排除）。2026-10-18 接上请求级换号 + 冷却后它**会写**标记
  // （额度至 UTC+8 当日 24:00 / 限流 1h）⇒ 必须登记，否则标记写进去却清不掉。
  //
  // ⚠️ 刻意**不传** `accountPool`（与 minimax 同一理由）：那会让 `stream()` 的
  // 反查与轮换在探测路径上复活（探测失败若写回限流标记，会把「重测 A 账号」
  // 变成污染池的副作用）。也**不传** `fetchRemoteModels` / `readImage`。
  accio: {
    createProbeAdapter: (ref, credential) => new AccioAdapter({
      resolveCredential: async () => credential as AccioCredential,
      refresh: async () => {},
      product: ACCIO,
    }),
  },
  // OpenCode Zen。
  //
  // ## ⚠️ 这里**必须**用第三个参数 `entry`，不能只靠 `credential`
  //
  // Zen 的出口与指纹的**权威在账号池条目**，不在凭据里：RPC 的
  // `opencode.setProxy` 落到 `AccountPool.setOpencodeProxy`，只写
  // `entry.opencodeProxy`（**不回写凭据**）；指纹代次同理只写
  // `entry.opencodeFingerprintGeneration`。只拿凭据去造槽，探测就会
  // **走错的出口 IP、发错的 project id** —— 而探测的全部意义正是
  // 「用这个账号的真实出网条件打一次请求」。
  //
  // ## ⚠️ 早先这里登记的「豁免」理由是**实测证伪的**
  //
  // 旧理由称「它的适配器需要整个 identitySlots 序列 + 池条目 id
  // （slotId 与 refName 不是同一键空间），补它要给 `ProbeDeps` 加池透传，
  // 属接口扩张」。逐条核对后不成立：
  //   - 探测**不需要整个序列**，只需要**它自己那一个**槽：`stream()` 只调
  //     `identitySlots()` 取序列，不读目录（`fetchRemoteCatalog` 只在
  //     `catalog()` 里用），而探测路径本就刻意不传 `markLimited`；
  //   - **不需要池**：`probeWithAdapter` 手上已有完整的 `ProviderAccountEntry`，
  //     它带着权威的代理与代次；
  //   - `slotId` 与 `refName` 的键空间差异在这里不成立：探测不调
  //     `markLimited`，没有任何按 slotId 写回的动作。
  // ⇒ 真正缺的只是「把 `entry` 交给工厂」这一件事，故给
  // `createProbeAdapter` 加了可选的第三个参数（纯放宽，其余各家的适配器不受影响）。
  //
  // ## 刻意**不**传的四个钩子
  //
  // `fetchRemoteCatalog` / `disabledModels` / `markLimited` / `readImage`
  // 一律不传，与其余家同一理由（探测是轻量存活检查，不写任何状态、
  // 不为一次探测额外拉目录）。其中 `markLimited` 尤其重要：探测失败若写回
  // 限流标记，会把「重测 A 账号」变成污染池的副作用。
  //
  // ## ⚠️ 槽由 `poolEntrySnapshot` 造，且**不继承**池里的 `enabled`
  //
  // `listIdentitySlots` 会跳过 `enabled === false` 的条目，而探测的既定语义是
  // 「**停用账号也要能重测**」（`account-probe.ts` 模块头第 2 条设计）。
  // 故这里**不传** `enabled`，用 `poolEntrySnapshot` 的缺省 `true`。
  //
  // UA 用产品默认值：`probeById` 是**模块级**常量（在 `apply()` 之前求值），
  // 够不到那里懒探测出的真机版本。UA 只是伪装维度、服务端未校验真实性
  // （见 opencode 接线块的注释），且**不影响**限流判定的结论。
  opencode: {
    // ⚠️ `OpencodeAdapterOptions` **没有** `credentialRef` / `resolveCredential`
    // / `refresh` 这三项（其余各家的适配器有）：Zen 的身份就是槽本身，
    // 适配器不做续期、也不按 ref 解析凭据。多传会被 tsc 直接点破。
    createProbeAdapter: (_ref, credential, entry) => {
      const credentialKey = (credential as OpencodeCredential | undefined)?.api_key
      // 凭据坏掉/缺失时退回匿名 key：与主接线块同一兜底口径，
      // 让探测报「账号不可用」而不是抛空指针。
      const apiKey = typeof credentialKey === 'string' && credentialKey.length > 0
        ? credentialKey
        : OPENCODE.anonymousKey
      return new OpencodeAdapter({
        identitySlots: async () => listIdentitySlots(
          [
            poolEntrySnapshot({
              id: entry?.id ?? OPENCODE.id,
              apiKey,
              // ⚠️ 刻意不传 `enabled`（缺省 true）：停用账号也要能重测。
              proxy: entry?.opencodeProxy,
              generation: entry?.opencodeFingerprintGeneration,
            }),
          ],
          OPENCODE.defaultUserAgent,
        ),
      })
    },
  },
  // Codely（Unity 团结引擎）→ **本 fork 独有**（2026-10-20）。
  //
  // 适配器接上了请求级换号 + 冷却（`codely-adapter.ts` 的 `updateModelRateLimit`
  // 写点：402/预算耗尽 → UTC+8 次日 0 点、429 → 1h）⇒ 必须登记探测适配器，
  // 否则标记写进去永远清不掉（minimax / accio 同型缺陷第 N 次）。
  //
  // 探测只发一次最小请求（`/api/model-status`，Bearer 即可、无需签名）⇒ 单槽
  // 喂这一份凭据即可，不需要池（与 modelscope / accio 同款）。
  // ⚠️ 刻意**不传** `accountPool`：那会让 `stream()` 的换号在探测路径上复活
  //（探测失败若写回限流标记，会把「重测 A 账号」变成污染池的副作用）；
  // 也不传 `readImage`（探测是轻量存活检查，不为它拉图片通道）。
  codely: {
    createProbeAdapter: (_ref, credential) => new CodelyAdapter({
      credentialProvider: async () => credential as CodelyCredential | undefined,
    }),
  },
}

/** 注册 codeartsAuth 服务与 codearts LLM 路由（不注册斜杠命令）。 */
export function apply(ctx: Context): void {
  // 本插件自带 大肥鱼饭碗 设置页，关闭 0.1.7 起由 Config schema 反渲染的自动表单
  // （老契约没有 configure()，静默跳过）。
  suppressAutoSettingsPage(ctx)

  // provider 配置命名空间的注册**只在老契约（≤0.1.6）下执行**：
  // 那时 `settings.register` 可用，十二个 namespace 分别对应 codearts 路由、
  // CodeBuddy（buddy）、WorkBuddy（workbuddy）、LobsterAI（lobsterai）、
  // Qoder（qoder / qodercn）、TRAE（trae）、Cline（cline）、Loomy（loomy）、
  // Raccoon（raccoon）、MiniMax（minimax）与 Zcode（zcode）。
  //
  // 0.1.7-rc.1 起 settings 换成 SettingsForms（无 register），命名空间只能是
  // profile 条目 id，故这里不做任何注册。
  //
  // ⚠️ 2026-10-01 起各 provider 已**不再**声明为可配置 provider，故这批 namespace
  // 在模型设置页上已无消费者（详见该函数头的说明）。
  // ⚠️ 2026-10-08 改：namespace 清单从 `PROVIDER_REGISTRY` 派生，不再手抄 13 个。
  //    原先改 registry 的 `settingsNamespace` **行为完全不变**（宿主侧另有一份
  //    13 个字面量的副本），是「唯一真相源」名不副实的一处。
  //
  // ⚠️ **顺序变了**：原清单是 `buddy, workbuddy, codearts, lobsterai, …`（人工排列），
  //    派生后是 registry 的声明顺序（`codearts, buddy, workbuddy, …`）。
  //    ⚠️ **这个顺序无关紧要**：`registerProviderSettings` 内部是 `for (const ns of …)`
  //    逐个 `settings.register(ns, Config)`，注册顺序不影响 `describe()` 的语义
  //    （它按 ns 查、不按序）。**但必须确认既有断言不断言顺序** ——
  //    执行时 `rg -n "llm-buddy|llm-zcode|llm-codearts" tests/unit/` 核对；
  //    若有断言依赖顺序，改为**集合相等**（`.sort()`）而不是保持原顺序。
  registerProviderSettings(
    ctx,
    // ★ 本 fork：只注册已启用渠道的 namespace（关掉的渠道不留空壳命名空间）。
    ...ACTIVE_PROVIDERS
      .map((d) => d.settingsNamespace)
      .filter((ns): ns is string => ns !== undefined),
  )
  const service = new CodeArtsAuth(ctx)
  const pool = new AccountPool(ctx)

  /**
   * **AutoClaw 存量账号去重自愈**（2026-10-19 用户三次报障后定稿）。
   *
   * 用户形态：面板里同一个手机号出现 **3 次**，积分被重复累加
   *（20842 + 20842 + 20842 = 62526，真实余额只有 20842）。
   *
   * ## 为什么不能只按凭据字段 `user_id` 去重（两轮失败的原因）
   *
   * 实测三条凭据的字段形态**不一致**：
   *
   * | ref | 凭据 `user_id` | JWT `user_id` | JWT `guid` |
   * |---|---|---|---|
   * | `A6539467` | —（无） | `839684` | `""`（空） |
   * | `D6BF9EB2` | —（无） | `839684` | `""`（空） |
   * | `A3C56DD6` | `7c54a9a…`（UUID） | `839684` | `""`（空） |
   *
   * ⇒ 有两个**互不相通**的 id 空间：UUID（账号主键，服务端 `user-profile`
   *    也用它）与 `numericUserId`（JWT 的 `user_id`，纯数字）。
   *    「字段优先、JWT 兜底」会让前两条落到 `839684`、第三条落到 UUID
   *    ⇒ **分裂成两组，一条都去不掉**（用户二次报障「怎么还是在啊」）。
   *
   * ## 定稿做法：先用服务端把 UUID **补齐**，再按 UUID 去重
   *
   * 1. 逐条 ref 调 `user-profile`（实测三条都能拿回同一个 UUID）把
   *    `user_id` 字段**写回凭据** —— 这一步同时修好了「老凭据缺字段」；
   * 2. 补齐后全池统一按 `user_id`（UUID）分组去重。
   *
   * ⚠️ **异步、不阻塞启动**：`void` 而非 `await`。补齐要走 N 次网络，
   *    等它会让插件启动慢一拍；失败也只记 warn（自愈是尽力而为）。
   * ⚠️ **只对 autoclaw 启用**：其他渠道的 `access_token` 会轮换，
   *    拿它去重会把**不同账号误合并**。这是按渠道逐个放开的白名单。
   * ⚠️⚠️ `void` 起**必须挂 `.catch`**（双保险）：函数内部已对读池与逐条
   *    失败各自兜底，但「`void` 一个 async 函数」本身就是未捕获 rejection 的
   *    入口 —— 将来有人在函数里加一条会抛的新腿，这里仍能兜住并留下日志。
   *
   * ⚠️ **本 fork 的闸门**：`autoclaw` 不在 `ALLOWED_CHANNELS` 里，自愈的唯一作用
   *    就是改写它的凭据（`ctx.credentials.set`）与账号池条目 —— 对一个已关闭的
   *    渠道做这件事，正是「白名单只拦注册、拦不住副作用」那类缺陷（用户
   *    2026-10-27 审查第①项）。闸门放在**调用点**而不是函数体内：函数体保持
   *    与上游一致，闸门一眼可见、且不必读完整函数就知道它跑不跑。
   */
  if (isChannelAllowed(AUTOCLAW.id)) {
    void autoclawSelfHeal(pool, ctx).catch((error: unknown) => {
      ctx.logger?.warn?.(
        `[autoclaw] 账号自愈失败（不影响启动）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  /**
   * ★★ **共享余额读数缓存**（2026-10-15 规格 §5.7；2026-10-16 起 loomy 也接入）——
   * 本进程**唯一**的一份。
   *
   * ## ⚠️⚠️ 为什么必须建在**这里**（位置不变式）
   *
   * 消费者有三处，定义顺序不能变：
   * ① loomy 选号器（`loomyBalanceSelector`，约在本段之后）—— 2026-10-16 新增；
   * ② `credits.balances` 端点（经 `registerBalanceCache` 的进程级注册位）；
   * ③ 聚合折算（`sharedExpiryProbe` 的 `balanceOf`）。
   *
   * ⚠️ 我第一版把它留在文件后段（`sharedExpiryProbe` 旁边）⇒ ① 会读到
   *   **尚未初始化的 `const`**（TDZ）—— `tsc` 不报错（`const` 在模块作用域
   *   有块级作用域，闭包里引用合法），只在 loomy 首次选号时抛
   *   `ReferenceError`。⇒ 位置本身就是一条不变式，登记在此。
   *
   * ## 谁在用它（各有各的取舍）
   *
   * | 消费者 | 传哪些账号 | 为什么 |
   * |---|---|---|
   * | `credits.balances` 端点（积分面板 / 徽标） | **全部**账号（含停用 —— 既有语义） | 用户要在同一个列表里看到每个账号还剩多少 |
   * | loomy 选号（余额分档） | **候选**账号（已过滤 enabled/限流） | 不该用没资格的号去推断整体 |
   * | 聚合折算（buddy 系四家） | **可用**账号 | 不可用的账号本来就不该参与候选 |
   *
   * ⇒ 「谁该被读」是**调用方的取舍**，「同一账号的读数在 TTL 内复用」才是本缓存
   * 提供的**基础设施**（用户 2026-10-15 的更正原话见 `balance-cache.ts` 模块头）。
   *
   * ⚠️⚠️ **必须是同一个实例**：两次 `createBalanceCache` 会让同一个账号被查两次
   *（那正是本模块要消除的），且 `clear` 也得分两次 —— 与 `sharedExpiryProbe` 那条
   * 「初版内联导致两份缓存」的真实缺陷**同型**。
   *
   * ⚠️ TTL 120 秒（规格 §5.7.4-3 的诚实登记）：聚合是**多候选回落**结构，
   *   陈旧 60 秒的代价是「多一次失败尝试后回落」（用户看不到失败），换来上游
   *   请求不翻倍；面板侧有 5 分钟重探与手动 `force` 兜底。
   *
   * ⚠️ 陈旧兼顶上界 15 分钟（`staleTtlMs`）：用户 2026-10-16 要求
   *   「拿不到新数据就读旧数据」，但必须有上界 —— 见 `balance-cache.ts` 的注释。
   */
  const balanceCache = createBalanceCache({
    ttlMs: 120_000,
    failureTtlMs: 15_000,
    // ⚠️ 中止判据**复用**适配器导出的共享实现（它含 `code: 'ABORTED'` 与 499 报文
    //    两条腿）—— 不要在装配层再写一份（本仓库已有 4 份同义实现，别再添第五份）。
    isAbort: (error) => isAbortLikeError(error),
    fetch: (provider, entry) => fetchBalanceReading(pool, provider, entry),
  })
  // ⚠️ 注册到**进程级**注册位：`credits.balances` 端点拿不到本函数的局部变量
  //   （`registerJetHubRpc` 的 4 形参不变式不许加第 5 个），故走与
  //   `ProviderRuntime.credits` 同一张表（见 `provider-runtime.ts` 的说明）。
  //   ⚠️ 未注册 ⇒ 端点回退到自己的原路径（行为与升级前一致）—— 那是刻意的降级。
  registerBalanceCache(balanceCache)

  /**
   * ★★ **余额缓存的后台刷新器**（2026-10-18，Task 2）。
   *
   * ## 为什么必须有它（用户原话）
   *
   * 「这个 2 分钟是 interval 不是 timeout」—— 原实现是 cache-aside（读驱动），
   * 而读路径在提交 `a725101` 之后陈旧命中**一个请求都不发** ⇒ 没有任何东西会再取
   * 新数据 ⇒ 缓存会永远陈旧。本刷新器补上「后台保鲜」那一半。
   *
   * ## ⚠️ 位置不变式
   *
   * 必须建在 `balanceCache` **之后**：它要拿缓存实例（与上面那条位置不变式同源）。
   *
   * ## ⚠️ 凭据必须**在装配层解析**
   *
   * `fetchBalanceReading`（本文件下方）在 `entry.credential === undefined` 时
   * 直接抛「凭据未提供」⇒ 刷新器若传空 entry，**每一轮都被记成失败读数**
   * （外面看「刷新器在跑」，实则永远拿不到新值 —— 零报错的恒绿形态）。
   * ⇒ 这里按 `credentialRef` 解析（与 `jet-hub-rpc.ts` 的
   *   `resolveCredentialForCache` **同款**口径）；解析失败返回 undefined，
   *   刷新器据此**跳过**该账号（那一枪必然失败，纯浪费）。
   */
  const balanceRefresher = createBalanceRefresher(balanceCache, {
    // ⚠️ `listAllAccounts()` 实测是 **async**（`src/account-pool.ts:1308`）；
    //    刷新器内部一律 `await`，直接传引用即可。
    // ⚠️ 传**全部**账号（含停用）：停用只影响自动选号（仓库铁律「续期不得按
    //    `enabled` 过滤」），凭据仍需保鲜 —— 由刷新器自己判低频节奏。
    listAccounts: () => pool.listAllAccounts(),
    resolveCredential: async (refName) => {
      const resolved = await ctx.credentials.resolve(credentialRef(refName))
      if (resolved === undefined) return undefined
      try {
        return JSON.parse(resolved.value)
      } catch {
        return undefined
      }
    },
    // ⚠️ **引用常量、不要重打 `60_000`**（2026-10-18 复审 Minor 修正）：
    //    装配层与 `createBalanceRefresher` 各写一份同一个字面量，等于把
    //    `DEFAULT_STALE_TTL_MS` 刚消灭掉的那类重复又引入了一次。
    //    ⚠️ **理由（别丢）**：周期 = 共享缓存 `ttlMs`(120s) 的**一半** ——
    //    周期恰等于 `ttlMs` 时条目在刚过期那一刻才被刷，读路径仍会频繁撞上
    //    「陈旧且后台刚开始刷」，常新目标落空；取一半 ⇒ 任何时刻至少有半个周期余量。
    intervalMs: REFRESH_PERIOD_FALLBACK_MS,
    // ⚠️⚠️ **日志必须接上**：刷新器把失败吞掉并记日志（后台没有调用方可通知）
    //    ⇒ 不接 logger 就是**完全静默**：面板只显示「查询失败」，用户与维护者
    //    都看不到「后台刷新器压根没在刷」。这两行同时是接线守卫的判据落点。
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
  })
  // 生命周期挂 `ctx.effect`，与插件一致（释放后停手）—— 与既有 `modelsDevTimer`、
  // `startCatalogPrewarm` 同款约定。
  ctx.effect(() => {
    balanceRefresher.start()
    return () => { balanceRefresher.stop() }
  })

  // CodeArts 目录的**各来源成败**出参（issue IKJVTF 复审，审计 I3）：
  // `service.refreshModels` 每轮原地写入，适配器的 `catalogComplete` 读它。
  // 初值两个 false —— 在首轮真正拉取之前，**没有**任何来源可算「取到」。
  service.lastCatalogOutcome = { gatewayOk: false, builtinOk: false }

  // 「已失效模型」剔除：注入 ctx 只为把日志接进 DSH logger 并复用同一份 home
  // 解析。必须在任何 `registerXxxLlm` 之前调用 —— 各适配器经
  // `registerAdapterIdempotent` 注册时就会包装上剔除逻辑（见该函数注释）。
  configureDeadModelStore(ctx)

  // ===== Token 账本持久化（第 2 期 · 日聚合落盘）=====
  //
  // ⚠️ 账本本体是模块级单例（`token-ledger.ts`），没有 ctx 可拿 —— 故在启动时
  // 把后端挂进去（`attachTokenLedgerStore`）。挂载发生在**任何适配器注册之前**：
  // 启动早期就有模型请求（标题生成等）时，落盘已在位。
  //
  // ⚠️ 后端契约是**绝不抛错**（`recordTokenUsage` 的调用点在推理关键路径上，
  // 见其函数注释），`FileLedgerStore` 内部已按此实现。
  //
  // ⚠️ dispose **必须用返回的 disposer**（不能无条件 `attach(undefined)`）：
  // 插件 fiber 重启时新 apply 与旧 fiber 的异步 dispose **交错执行**
  //（本仓库已确证的事故，见 `llm-register-compat.ts` 模块头），无条件摘会把
  // **新实例刚挂上**的后端摘空 ⇒ 落盘停摆且历史视图恒为空。disposer 自带所有权
  // 校验（只摘自己的），并顺带 `flush` 当前这份数据。
  const tokenLedgerStore = createTokenLedgerStore(ctx)
  const detachTokenLedger = attachTokenLedgerStore(tokenLedgerStore)
  ctx.effect(() => () => {
    try {
      tokenLedgerStore.flush()
    } finally {
      detachTokenLedger()
    }
  }, 'token-ledger-persistence')

  // WorkBuddy provider 已从中国版（copilot.tencent.com）改造为国际版
  // （www.workbuddy.ai）。旧账号存的是中国版凭据，其 token.domain 指向旧端点，
  // 用新 endpoint 发请求必然失败且会一直续期失败，故启动时清理掉。
  //
  // ⚠️⚠️ 判据**不是**「凭据 domain ≠ 产品 apiDomain」（那会误删合法账号，见
  // `pruneAccountsWithForeignDomain` 的注释），而是「domain 确证属于**其它**产品」：
  // 故这里必须把**别的产品的已知域**传进去，否则函数无从判断「失配」。
  // 未知域一律保留 —— 跨机导入的账号 / 上游新增 realm 主机都不该被静默删除。
  const foreignBuddyDomains = ALL_PRODUCTS
    .filter(product => product.id !== WORKBUDDY.id)
    .flatMap(product => [...(product.knownDomains ?? [])])
  void pool.pruneAccountsWithForeignDomain(WORKBUDDY, foreignBuddyDomains).then((removed) => {
    if (removed.length > 0) {
      // ⚠️ 用 `warn` 而不是 `info`：这是**删除用户数据**的动作。原先记 `info`，
      // 与「账号自己没了、日志里什么都没有」的报障形态同型（对抗审计指出）。
      ctx.logger.warn(
        `[jet-hub] 已清理 ${removed.length} 个 WorkBuddy 旧版（中国版）账号，请重新登录：${removed.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 清理 WorkBuddy 旧版账号失败：${String(error)}`)
  })

  // ⚠️ **CodeArts 不注册任何斜杠命令**（`codearts-login` / `codearts-status` /
  // `codearts-refresh` 三个已删除）：登录、状态与续期统一在 大肥鱼饭碗 设置页完成，
  // 与 buddy / workbuddy / lobsterai / qoder / trae 的既有做法一致。
  // ===== provider-wiring BEGIN（tests/helpers/source-bundle.ts 的拼接锚点；勿删/勿改字面量）=====
  // ⚠️ **provider 接线（架构审查 ⑨）**：原本这 2000 行装配段全摊在 `apply()` 里，
  //    把入口函数撑成 4623 行的迷宫。现已搬到 `src/provider-wiring.ts` 的
  //    `wireProviders()` —— 那里没有分支、没有顶层 `await`、不碰 `ctx.effect`，
  //    只按顺序造实例并返回，故这里是唯一调用点。
  //
  //    ⚠️ 解构出来的名字与搬走前**逐个同名**，下方 3000 行代码一个字都不用改；
  //    两个图片桥接工厂（`makeReadImage` / `makeReadImageRequest`）刻意留在本文件，
  //    因为 region 之后的适配器还在用、且 `plugin.spec.ts` 从 `index.js` 导出它们，
  //    搬走会形成循环依赖 —— 所以传的是工厂函数本身。
  const {
    codearts,
    throwIfAllAccountsRateLimited,
    astudioLockedError,
    autoclawLockedError,
    buddy,
    buddyAdapter,
    workbuddy,
    workbuddyAdapter,
    lobsterai,
    lobsteraiAdapter,
    qoder,
    qoderAdapter,
    qoderCn,
    qoderCnAdapter,
    trae,
    traeAdapter,
    cline,
    clineAdapter,
    loomy,
    loomyAdapter,
    raccoon,
    raccoonAdapter,
    minimax,
    minimaxAdapter,
    minimaxIntl,
    minimaxIntlAdapter,
  } = wireProviders(ctx, pool, service, balanceCache, makeReadImage, makeReadImageRequest)
  // ===== provider-wiring END =====
  const gemini = new GeminiAuth(ctx, { fetchFor: geminiFetchForAccount })
  const geminiSigStore = createGeminiSigStore(ctx)
  // ⚠️ 项目号探测缓存必须**在这里建一次、长期复用** —— 每次 `stream()` 现造
  // 等于没有跨请求缓存，每轮推理都会多打一次 `loadCodeAssist`。
  const geminiProjectCache = new Map<string, string>()
  const geminiAdapter = registerGeminiLlm(ctx, {
    credentialRef: credentialRef(GEMINI.defaultCredentialRef),
    // ⚠️ provider 实参用 GEMINI 而非字面量（同 minimax 的既有约定：
    // 写死字面量在改名/多产品场景下会静默查不到账号）。
    resolveCredential: createCredentialResolver<GeminiCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(GEMINI.id, id) } },
      {
        product: GEMINI,
        // ⚠️ 与 raccoon / minimax 同款：兜底是**裸 `JSON.parse`**（历史形态，
        // 本 Task 逐字保留，不在此处加形状校验 —— 那会是行为变更）。
        // `getAvailableAccount` 的凭据类型是历史遗留的联合类型，与
        // `GeminiCredential` 无充分重叠，故经 `unknown` 转换；运行时安全性由
        // provider 过滤保证（查询用 `GEMINI.id`，取到的必是 gemini 凭据）。
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as unknown as GeminiCredential
          } catch {
            return undefined
          }
        },
        fallback: { kind: 'ref', refName: GEMINI.defaultCredentialRef },
        // 区分「全部限流」与「没登录」（见该助手的说明，IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // ⚠️ 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      const available = await pool.getAvailableAccount(GEMINI.id, '')
      if (available) {
        // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回
        // 账号池，否则 UI 一直显示「已过期」而实际能正常发消息。
        // ⚠️ `getAvailableAccount` 返回 **`{ entry, credential }`** 两层 ——
        // 账号 id 与 credentialRef 在 **`available.entry`** 里，**不是**
        // `available.id` / `available.credentialRef`（那是 `undefined`，
        // 会让续期**静默写不回账号池**）。
        await gemini.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await gemini.refresh()
      }
    },
    // 模型表是**静态**的（用户拍板：不拉远端目录，Cloud Code 没有模型列表端点）。
    // 故这里不传 `fetchRemoteModels`。
    // 图片两跳：先按 640,000 px 预算取缩放版，拿不到才发原图。
    readImage: makeReadImage(ctx),
    readImageRequest: makeReadImageRequest(ctx),
    sigStore: geminiSigStore,
    accountPool: pool,
    product: GEMINI,
    // 项目号：缺省**自动探测**（`loadCodeAssist` 的 `cloudaicompanionProject`），
    // 不是恒为 `aicode-consumers`（那只是探测为空时的兜底）。
    projectCache: geminiProjectCache,
    // ⚠️ **推理主路径的出口**（IKLTZ2）：此前这里只有裸 `fetch`（连 seam 都没有）。
    fetchFor: geminiFetchForAccount,
    persistProject: async (value: string) => {
      // ⚠️ 回写到**解析凭据时所用的那个账号**，不是默认单凭据 ref ——
      // 写错对象会让另一个账号的凭据被污染。
      const available = await pool.getAvailableAccount(GEMINI.id, '')
      const ref = available
        ? available.entry.credentialRef
        : credentialRef(GEMINI.defaultCredentialRef)
      await ctx.credentials.set(credentialRef(ref), value)
    },
    ...ctx.logger === undefined ? {} : { logger: ctx.logger },
  })

  // ===== Accio（阿里 Accio Work）=====
  //
  // 与其余 provider 的**三处实测差异**（`docs/agent-notes/providers-accio.md`，
  // 全部来自真实凭据的对照实测，**不许「顺手统一」**）：
  //   1. **有标准 OAuth 2.0 + PKCE**（`client_id='accio-work'`，公开客户端）
  //      ⇒ 完全脱离 IDE，**不读**本机 `credentials.enc`、**不需要** DPAPI；
  //   2. **不需要 SecurityGuard 签名** —— 不带 `pctb-x-*` 同样 200
  //      ⇒ 不需要 `security_guard.node` 与那串阿里 DLL（参考实现把它当必需是过度设计）；
  //   3. 但 **token 必须放 body 的 `token` 字段** —— 放 `Authorization` 头恒
  //      **流内 402**（HTTP 仍是 200 ⇒ 不看流内 `error_code` 会误判成「成功但没内容」）。
  //
  // 服务名由 AccioAuth 依 product.id 派生，注册为 ctx.accioAuth。
  // 不注册斜杠命令：入口在 大肥鱼饭碗 的 Accio 面板。
  // ===== AutoClaw（智谱清言）=====
  /**
   * 按凭据 ref 解析 AutoClaw 凭据（供选号器查余额与最终取凭据共用）。
   *
   * ⚠️ **两站共用这一份**（`autoclaw` / `autoclawintl` 的凭据形状逐字相同：
   * 同一套协议实现，差异只在主机与 ref 前缀）—— 与 qoder 那份同因，
   * 各写一遍 = 改一处漏一处。
   *
   * ⚠️ **逐字保留历史上的裸 `JSON.parse` 形态**（不在此处加形状校验）：
   * 加校验是一次**行为变更**（此前被接受的损坏凭据会变成被拒），不在本任务范围内。
   */
  const resolveAutoclawCredentialByRef = async (refName: string) => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as unknown as AutoclawCredential
    } catch {
      return undefined
    }
  }
  /**
   * AutoClaw 两站的**按「额度何时作废」分档选号器**（2026-10-21，
   * 用户要求「补锁定开关」）。
   *
   * ## 为什么本家需要它
   *
   * `autoclaw-credits.ts` 的批次映射里有一条**代码分支**：`wallet_expires_at`
   * 缺失 / `<= 0` 的发放 ⇒ 进 `permanentByLabel` ⇒ **不带 `deductionEndTime`**
   * （= 永久桶）。⇒ 只要上游下发那种条目，用户钱包里就会有永不作废的积分，
   * 需要能保护它们。补登记 `permanentLock` **必须同时接上本选号器**，
   * 否则就是**假开关**（按钮在、点了不拦 —— `credential-resolver.ts` 的
   * `allowPermanent` 只在 `balance` 计划存在时才被读到）。
   *
   * ⚠️⚠️ **前提强度如实标注（2026-10-21 二轮审计）**：上述「永久桶」分支
   * **结构上可达、但零实测**。仓库内唯一一次针对流水字段完整性的实测
   *（`5fbe7ab` 的 commit message）结论是「**28/28 全带 `wallet_expires_at`**」——
   * 方向上**否定**该形态存在。若上游确实恒带到期字段，则本家的永久桶**恒为空**
   * ⇒ `allowPermanent` 为 true/false 行为完全相同 ⇒ 这个开关**永不产生实际效果**
   *（但也不会出错：它只是把「已存在的分档能力」接上）。
   *
   * ⇒ 保留本接线（成本为零、与仓库 11 家同构、上游一旦下发无到期条目即生效），
   *   但**不得**声称「本家确实有永久桶」。可核实的验证方法见审计报告 §十三。
   *
   * ## 为什么复用 `BuddyBalanceSelector`
   *
   * 分档判据（`splitBuddyCreditsByExpiry`）只读通用的
   * `packages[].{active, remaining, deductionEndTime}`，**与 provider 无关**；
   * `autoclaw-credits.ts` 的批次包正是这个形状（`deductionEndTime` 由
   * `wallet_expires_at` 秒级归一成毫秒）。
   *
   * ## ⚠️ 与 buddy 系的**关键差异**（别照抄那两行）
   *
   * | | buddy 系 | AutoClaw |
   * |---|---|---|
   * | `rateLimit` | 省缺 true | **false**（不写 `modelRateLimits`、不在 `probeById`）|
   * | 请求级换号 | 有 | **刻意没有** |
   * | 「每日红」池语义 | 有 | **不适用**（签到积分是发放进余额、按批次到期）|
   *
   * ⇒ 本家的锁定只作用于「按余额分档选号」这一层，不涉及换号冷却（本来就没有）。
   *
   * ## ⚠️ 两家各建一个实例，不得合并
   *
   * 选择器内含**按账号 id 的缓存**，跨站共用会让一站的读数污染另一站
   * （与 minimax / qoder 两站同因）。
   *
   * ## ⚠️ 必须各传自己的 `product`
   *
   * `AUTOCLAW` 指向国内基址、`AUTOCLAW_INTL` 指向国际基址（`autoglm-api.autoglm.ai`）
   * —— 互换的后果**不是报错**而是静默：对方站点不认本站 token ⇒ 余额恒 `null`
   * ⇒ 未锁定时换号优化失效、锁定时永远报「没有可用账号」。
   */
  const autoclawBalanceSelector = new BuddyBalanceSelector({
    product: AUTOCLAW,
    resolveCredential: resolveAutoclawCredentialByRef,
    fetchBalance: (credential, product) => fetchAutoclawCreditBalance(credential, { product }),
  })
  const autoclawIntlBalanceSelector = new BuddyBalanceSelector({
    product: AUTOCLAW_INTL,
    resolveCredential: resolveAutoclawCredentialByRef,
    fetchBalance: (credential, product) => fetchAutoclawCreditBalance(credential, { product }),
  })
  const autoclaw = new AutoclawAuth(ctx)
  const autoclawAdapter = registerAutoclawLlm(ctx, {
    resolveCredential: createCredentialResolver<AutoclawCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(AUTOCLAW.id, id) } },
      {
        product: AUTOCLAW,
        // ⚠️ 2026-10-21：改用上面共用的 `resolveAutoclawCredentialByRef`
        //    （原先这里是一份内联的逐字重复实现，两站各一份）。
        readCredential: resolveAutoclawCredentialByRef,
        fallback: { kind: 'ref', refName: AUTOCLAW.defaultCredentialRef },
        /**
         * ⚠️ **必须接 `balance`**（2026-10-21，用户要求「补锁定开关」）。
         *
         * registry 里登记 `permanentLock: true` 只让**按钮渲染**、RPC 放行；
         * 真正的拦截在 `credential-resolver.ts` 读
         * `pool.permanentLocked(providerId)` ⇒ 传给 `pickBuddyAccount`
         * 的 `allowPermanent`。**没有本段就是假开关**：按钮在、点了不拦。
         *
         * ⚠️ `reportPickedAccount: true` 是**必须的**（与 qoder / minimax 同因）：
         * 本家的旧闭包是**纯池选号**、账本**一直在回报**（见下面
         * `reportAccount` 那行）。接上 `balance` 后「分档选中」那一支若不回报
         * ⇒ token 用量记不到本渠道上（静默）。
         */
        balance: {
          kind: 'buddy',
          selector: autoclawBalanceSelector,
          // ⚠️ 本家独有文案（池名是「钱包流水批次」而不是 buddy 的「资源包」）。
          lockedError: autoclawLockedError('AutoClaw'),
          // ⚠️⚠️ 本家**曾**标过 `isFree: true`，那是**错的**（2026-10-21 二轮审计订正）：
          //   初版把「远端目录里没有它、但直接调用能用」误当成「不扣费」，而真机
          //   实测它**每次都扣积分**（`docs/autoclaw-models.md:25`）。现有 4 个模型
          //   全是 `isFree: false` ⇒ 本家确实没有模型级免费，显式表态即可。
          isFreeModel: NO_FREE_MODEL,
          reportPickedAccount: true,
        },
        // ⚠️ **必须接**（与 accio 同因）：本工厂的兜底是**固定 ref**
        //    （`AUTOCLAW_ACCESS_TOKEN`），而 大肥鱼饭碗 登录只写
        //    `AUTOCLAW_ACCOUNT_XXX` ⇒ 池被筛空时它会退到那个**从不被写入**的
        //    ref，报出误导性的「请先登录」（issue IKJOZ9 的形态）。
        //    ⚠️ 今天它是**恒不命中的死代码**（`autoclaw-adapter.ts` 不写
        //    `modelRateLimits` —— `provider-runtime-wiring.spec.ts` 的
        //    `WRITE_SITE_FILES` 把这一点登记为空并**验证**了「确实没有写点」）。
        //    保留它是有意的：判据是「兜底形态是否会让池被筛空时报错」，
        //    而不是「今天有没有标记」。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    product: AUTOCLAW,
    // ⚠️⚠️ **必须接 `readImage`**（2026-10-17 审计 P0 修复）。
    //    `zai_auto-fast` 的 `supportsImage: true` 有实测依据
    //    （`docs/autoclaw-models.md:42`：AutoClaw 体系内唯一支持图文多模态
    //    的通道），`resolveModel` 已据此向宿主声明 `['text','image']`
    //    ⇒ 宿主**不投影**图片、**原样**下发（`dsh-llm/lib/index.js:2311`）。
    //    ⚠️ **漏了它这条路径恒抛 `UNSUPPORTED_CONTENT`**：声明支持图片却
    //    必然失败，正是「声明即承诺」被破坏的形态（与 modelscope / opencode
    //    同约定：不传 `readImage` 时带图请求抛 `UNSUPPORTED_CONTENT`，而不是
    //    静默丢图让用户以为模型看到了图）。
    //    ⚠️ 刻意**不接** `readImageRequest` 缩放桥接：智谱侧对单图字节上限
    //    无实测依据，编一个预算是凭空造数字（同 modelscope 的取舍）。
    readImage: makeReadImage(ctx),
    // ⚠️⚠️ **2026-10-23 迁移：黑名单与「关闭供应商」已由共享骨架从账号池读走**
    //
    // 本家此前**手写** `listModels`，故需要分别传 `disabledModels` / `providerClosed`
    // 两个回调（2026-10-20 那次就是靠这两行兜住的）。用户定稿「实体 provider 一律走
    // 共享骨架」后，那两个字段**已删除** —— 现在唯一入口是本行传进去的池。
    // ⚠️ **不要把它们加回来**：那会重现「同一语义两套判据」（本仓库红线）。
    accountPool: pool,
  })

  // ===== AutoClaw 国际版（autoclawintl）=====
  //
  // 与国内版是**同一套协议实现**的第二个实例（差异全在 `AUTOCLAW_INTL` 配置里：
  // 基址 `autoglm-api.autoglm.ai` / 凭据 ref 前缀 `AUTOCLAWINTL_`）。
  // 刻意**不复制**任何 `src/autoclaw*.ts` 实现文件 —— 协议同源，复制会让同类
  // 缺陷（净额批次、临期分档、签到判据）修两遍（与 `minimaxintl` 同纪律）。
  //
  // ⚠️⚠️ **为什么是独立 provider**（三条判据全中，见 `autoclaw-product.ts`
  //    `AutoclawProduct` 的注释表）：
  //    ① 账号体系不互通（国内手机号 `7c54a9ac…` / 国际邮箱 `2c99dc99…`）；
  //    ② API 主机不同；
  //    ③ **登录方式不同**（国内短信验证码 / 国际 Z.ai OAuth）。
  //
  //    实测佐证：拿国内签发的 token 打国际基址，`wallets` / `user-profile`
  //    一律 `410000 用户未登录`、推理 `401 Invalid token` ⇒ 用户体系物理隔离。
  //
  // ⚠️ **当前登录**：Z.ai OAuth 尚未接入（`state.nh` 来源未知，
  //    见 `AUTOCLAW_INTL` 的注释）⇒ 本 provider 目前只能手工注入 token 使用。
  //    接入后它会自己有一条 `login.startOAuth` 分支。
  const autoclawIntl = new AutoclawAuth(ctx, { product: AUTOCLAW_INTL })
  const autoclawIntlAdapter = registerAutoclawLlm(ctx, {
    resolveCredential: createCredentialResolver<AutoclawCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(AUTOCLAW_INTL.id, id) } },
      {
        product: AUTOCLAW_INTL,
        // ⚠️ 与国内版共用同一个解析器（两站凭据形状逐字相同）。
        readCredential: resolveAutoclawCredentialByRef,
        fallback: { kind: 'ref', refName: AUTOCLAW_INTL.defaultCredentialRef },
        // ⚠️ **必须接 `balance`**（与国内版同因同日，见那一段的长注释）。
        //    ⚠️ `selector` 必须是**国际站自己**那个实例（缓存不跨站共用）；
        //    `displayName` **必须**逐站区分（两站账号不互通，用户要知道去哪个面板解锁）。
        balance: {
          kind: 'buddy',
          selector: autoclawIntlBalanceSelector,
          lockedError: autoclawLockedError('AutoClaw (国际版)'),
          // ⚠️ 同国内版：本家无模型级免费（`isFree` 全为 false，见那处说明）。
          isFreeModel: NO_FREE_MODEL,
          reportPickedAccount: true,
        },
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    // ⚠️ provider 实参必须是 AUTOCLAW_INTL：写死 AUTOCLAW 会让国际站永远
    //    查不到自己的账号（本插件在 workbuddy 上踩过同类坑）。
    product: AUTOCLAW_INTL,
    readImage: makeReadImage(ctx),
    // ⚠️⚠️ 同国内版（2026-10-23 迁移）：黑名单与关闭意图由共享骨架从账号池读。
    //    两个站点**各一条** `accountPool`，漏一处即该站静默失效（本仓库的既有纪律）。
    accountPool: pool,
  })

  const accio = new AccioAuth(ctx)
  const accioAdapter = registerAccioLlm(ctx, {
    // ⚠️ **不传 `credentialRef`**：`AccioAdapterOptions` 里没有这一项 —— 该适配器
    // 从不直接读凭据 ref（`resolveCredential` 已把池选号与单凭据兜底都包住），
    // 与 trae / gemini 那几家「适配器自己读 ref」的形态不同。多传会被 tsc 拒。
    // provider 实参用 ACCIO 而非字面量（同 minimax / gemini 的既有约定：
    // 写死字面量在改名 / 多产品场景下会静默查不到账号）。
    // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（见 buddy 处说明）。
    resolveCredential: createCredentialResolver<AccioCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(ACCIO.id, id) } },
      {
        product: ACCIO,
        // ⚠️ 与 raccoon / minimax / gemini 同款：兜底是**裸 `JSON.parse`**（历史形态，
        //    逐字保留，不在此处加形状校验 —— 那会是行为变更）。
        //    `getAvailableAccount` 的凭据类型是历史遗留的联合类型，与
        //    `AccioCredential` 无充分重叠，故经 `unknown` 转换；运行时安全性由
        //    provider 过滤保证（查询用 `ACCIO.id`，取到的必是 accio 凭据）。
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as unknown as AccioCredential
          } catch {
            return undefined
          }
        },
        fallback: { kind: 'ref', refName: ACCIO.defaultCredentialRef },
        // ⚠️ **必须接**：本工厂的兜底是**固定 ref**（`ACCIO_ACCESS_TOKEN`），而
        //    大肥鱼饭碗 登录只写 `ACCIO_ACCOUNT_XXX` ⇒ 池被筛空时它会退到那个
        //    **从不被写入**的 ref，报出误导性的「请先登录」（issue IKJOZ9 的形态，
        //    本仓库 12 家同型缺陷）。
        //    ⚠️ 与 zcode 的差别正在这里：zcode 的兜底是 `kind: 'custom'`（会**再读
        //    一次账号池**），故它不会误报、**刻意不接**；accio 的兜底是固定 ref。
        //    ⚠️ 今天它是**恒不命中的死代码**（`accio-adapter.ts` 不写
        //    `modelRateLimits`，池永远不会因模型级限流把 accio 账号筛空 ——
        //    `provider-runtime-wiring.spec.ts` 的 `WRITE_SITE_FILES` 把这一点
        //    登记为空并**验证**了「确实没有写点」）。**保留它是有意的**：
        //    判据是「兜底形态是否会让池被筛空时报错」，而不是「今天有没有标记」——
        //    将来给 accio 接上请求级换号 + 冷却（如 minimax 在 IKJW32 那样）时，
        //    这层守卫已经在位，不会静默退化成「请先登录」。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // ⚠️ **必须刷新「解析凭据时所用的那一个」账号**，而不是默认单凭据 ref ——
      // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回账号池，
      //    否则 UI 一直显示「已过期」而实际能正常发消息（issue !IKIRTT 的形态）。
      // ⚠️ 池里没有账号时退到默认单凭据 ref：`AccioAuth` **没有** 无参 `refresh()`
      //    （与 buddy / trae 那几家不同），它的续期入口一律是
      //    `refreshAccountCredential(refName, …)`。
      const available = await pool.getAvailableAccount(ACCIO.id, '')
      if (available) {
        await accio.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await accio.refreshAccountCredential(ACCIO.defaultCredentialRef)
      }
    },
    // 远端模型目录：`POST /api/llm/config/v2`（token 在 body）。
    // 失败或未登录一律返回空数组，由适配器回退 `ACCIO.fallbackModels`。
    fetchRemoteModels: () => accio.fetchModels(pool),
    accountPool: pool,
    product: ACCIO,
    // ⚠️ **图片通路已接通**（issue IKLR7V，2026-10-14 真机实测）：
    //    上游原生收图（Gemini 风格的 `parts[].inline_data`），且 `multimodal: true`
    //    的模型四色全对、`multimodal: false` 的模型**静默忽略图片**（含一家会幻觉）。
    //    故这里接上字节桥接，`inputModalities` 按**逐模型**的 `supportsImage` 如实声明。
    //    ⚠️ 泛型参数（`AccioCredential`）与上面 `resolveCredential` 一致。
    readImage: makeReadImage(ctx),
    readImageRequest: makeReadImageRequest(ctx),
  })

  // ===== AStudio（讯飞 AstronStudio，云端直连上游 MAAS）=====
  //
  // 形态与 OfficeAce / Accio 同类：进程内 LlmAdapter 直发远端，无子进程、无端口。
  // 独有语义：**没有 OAuth 授权页**，凭据来自本机 AStudio 客户端的明文会话文件；
  // 大肥鱼饭碗 的 account.create 因此走 importLocalSession（见 jet-hub-rpc.ts）。
  //
  // 服务名由 AstudioAuth 依 product.id 派生（astudioAuth）并在构造时自注册，
  // 故这里**不需要**再 ctx.provide('astudioAuth' / 'astudioLlm')。
  // 不注册斜杠命令：入口在 大肥鱼饭碗 的 AStudio 面板。
  const astudio = new AstudioAuth(ctx)
  /**
   * 按凭据 ref 解析 AStudio 凭据（供**选号器查余额**与最终取凭据共用）。
   *
   * ⚠️ 形状校验必须与 `astudio-auth.ts` 的 `parseAstudioCredential` 对齐
   *（判 `typeof access_token === 'string'`）。裸 `JSON.parse` 会让
   * `{"foo":1}` 这种损坏凭据被当成有效凭据返回，随后适配器的
   * `credential.access_token.length` 抛 **TypeError**（不可诊断），
   * 且发生在选号之后 —— 不在余额查询的 try/catch 覆盖范围内。
   * 这条注释与 LobsterAI / TRAE 那两处同因（写两遍、强度不一致 = 改一处漏一处）。
   *
   * 实测凭据字段（两个账号，2026-10-20）：`access_token`(65 字符) /
   * `account_id` / `uid` / `nickname` / `sso_session_id` / `token` /
   * `login_method` / `logged_in_at` / `source`。分档判据只用到
   * `access_token`（作为 `Cookie: ssoSessionId=` 的值去查 `/points/balance`）。
   */
  const resolveAstudioCredentialByRef = async (
    refName: string,
  ): Promise<AstudioCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      const parsed = JSON.parse(resolved.value)
      return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
        ? (parsed as AstudioCredential)
        : undefined
    } catch {
      return undefined
    }
  }
  /**
   * AStudio 的**按「积分何时作废」分档选号器**（为「锁定永久积分」提供依据）。
   *
   * ⚠️ 复用 `BuddyBalanceSelector` 而不是新写一个：分档判据
   * （`splitBuddyCreditsByExpiry`）只读通用的
   * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
   * AStudio 的 `buildAstudioBalance` 自 2026-10-20 起把
   * `{member,buy,activity}NextExpireTime`（不带时区的本地时间串，实测形如
   * `"2026-11-20T01:50:14"`）归一化到 `deductionEndTime`（毫秒），故结构一致。
   *
   * ⚠️ **缓存不能跨站共用**（选择器内含按账号 id 的缓存），故每家一个实例。
   *
   * ⚠️ 到期时间缺失的包归入**永久桶**（`splitBuddyCreditsByExpiry` 的保守方向）：
   * 宁用锁定时少用一个号，也不要把长期积分误当快到期烧掉。
   */
  const astudioBalanceSelector = new BuddyBalanceSelector({
    product: ASTUDIO,
    resolveCredential: resolveAstudioCredentialByRef,
    fetchBalance: (credential, product) => fetchAstudioCreditBalance(credential, product),
  })
  /**
   * AStudio 的凭据编排（候选筛选 → 余额分档 → 取凭据 → 回退）。
   *
   * ⚠️ 单独取名而不是内联，因为下面 `registerAstudioLlm` 的 `resolveCredential`
   * 是**零参**签名，必须先拿到这个带参函数再包一层（见那处注释）。
   */
  const astudioCredentialPlan = createCredentialResolver<AstudioCredential>(
    {
      pool,
      reportAccount: (id) => {
        if (id !== undefined) reportLedgerAccount(ASTUDIO.id, id)
      },
    },
    {
      product: ASTUDIO,
      // ⚠️ 必须传 ASTUDIO 自己的解析器（buddy 系那份虽然形状恰好兼容 ——
      //    同样判 `access_token` 是字符串 —— 但两家凭据字段不同：astudio 带
      //    `sso_session_id` / `login_method` / `source`，且将来任一方加校验就会分叉）。
      readCredential: resolveAstudioCredentialByRef,
      balance: {
        kind: 'buddy',
        selector: astudioBalanceSelector,
        // ⚠️ 本家**没有**免费模型概念（`AstudioAdapter` 只在 `listAllModels`
        //    的返回类型里声明了 `isFree?`，兜底表零个 `isFree: true`，
        //    上游目录也不返回该字段）⇒ 显式表态，不要删字段（见 `NO_FREE_MODEL`）。
        isFreeModel: NO_FREE_MODEL,
        lockedError: astudioLockedError('AStudio'),
        // ⚠️⚠️ **必须是 `true`**（2026-10-21 合并审计发现：PR !119 原写的 `false`
        //    让上面 `reportAccount` 成了**不可达的死接线**）。
        //
        // **原注释错在哪**：原文「与 buddy 系一致：本家旧闭包也没有回报」是**类比错误** ——
        // buddy 系能写 `false` 是因为它们的**适配器自己回报**（`buddy-adapter.ts` /
        // `trae-adapter.ts` / `lobsterai-adapter.ts` 都调 `reportLedgerAccount`），
        // 而 **AStudio 适配器全文零回报**（grep 实测 0 处），且 master 上它压根没有
        // `reportAccount` 接线 ⇒「旧闭包也没有回报」描述的是**一个缺陷状态**。
        //
        // **实测这行是死代码**（`credential-resolver.ts` 三条回报点：①免费短路 ——
        // astudio 无 `isFreeModel` 不进；②分档选中 `:388` 被 `!== false` 拦住；
        // ③池选号 `:454` —— ②里已 `return picked.credential`，走不到）：
        // ```
        // reportPickedAccount=false     → cred=true reports=[]     poolReached=false
        // reportPickedAccount=true      → cred=true reports=["a1"] poolReached=false
        // reportPickedAccount=undefined → cred=true reports=["a1"] poolReached=false
        // ```
        // ⇒ `false` 时**零回报**，而那正是 `reportAccount: (id) => reportLedgerAccount(...)`
        // 唯一的调用来源 ⇒ 那行接线永不执行。
        //
        // **后果**：`token-ledger.ts` 拿不到 `accountId` ⇒ 整笔用量归到 `'-'`（未归属）桶
        // ⇒ AStudio 账号卡片看不到自己的 token 用量，多账号时无法区分谁在烧。零报错零日志。
        //
        // **为什么改 `true` 是纯增益**：master 上 astudio 走 `auth.currentCredential()`
        // （单凭据、从未回报归属）⇒「有归属」是新增能力不是回退，它**没有旧闭包要保真**
        // （该分支在 master 上根本不存在）。⚠️ 与 buddy 系的取舍**不同源**，别照抄那两行。
        reportPickedAccount: true,
      },
      fallback: { kind: 'ref', refName: ASTUDIO.defaultCredentialRef },
      // 退到单凭据 ref 之前先证明失败原因：全被模型限流时报明确的限流错误，
      // 而不是降级成误导性的 MISSING_CREDENTIAL（见 throwIfAllAccountsRateLimited）。
      throwIfAllRateLimited: throwIfAllAccountsRateLimited,
    },
  )
  const astudioAdapter = registerAstudioLlm(ctx, {
    // ⚠️⚠️ **`accountPool` 必须传**（Gitee issue IKP8OF 审计发现，真实缺陷）：
    //    本家此前是**唯一**把 `createModelCatalog` 的 deps 传成 `{}` 的适配器
    //    （其余各家都传 `{ accountPool }`）⇒ 骨架里 `deps.accountPool?.disabledModelsFor`
    //    与 `providerClosedFor?.(...)` 全部因 `?.` **静默跳过** ⇒
    //    **用户在 大肥鱼饭碗 里关掉的 astudio 模型照样出现在选择器里**，
    //    关闭整个供应商也无效。症状与 modelscope 那次「接线层漏实参」逐字相同。
    // ⚠️ 仍**不传** `readImage`（实测六个模型的 input_modalities 全是 text，
    //    图片通路不成立），且本家刻意不做请求级换号。
    accountPool: pool,
    // ⚠️ **2026-10-20 新增**：此前本家不传 `resolveCredential`，适配器走
    //    `auth.currentCredential()` ⇒ **单凭据、无选号**，于是：
    //    · 「锁定永久积分」开关即使打开也**毫无作用**（没有选号层可拦）；
    //    · 多账号时永远只用池里「第一个可用」的那个，第二个号的临期额度用不上。
    //    接上 `createCredentialResolver`（与 buddy/lobsterai/trae 同一套编排）后，
    //    候选先按 `enabled` + 模型限流筛，再按「15 天内到期优先」分档。
    //
    // ⚠️⚠️ **必须包一层转成零参签名**：`createCredentialResolver` 返回的是
    //    `(modelId?: string) => Promise<TCredential | undefined>`，而
    //    `AstudioAdapterOptions.resolveCredential` 声明的是
    //    `() => Promise<AstudioCredential | undefined>`（**零参**）。
    //    直接把带参函数传过去会 TS2322（参数个数不兼容）。
    //    ⚠️ 传 `''` 而不是省参数：空串意味着「不按模型筛候选」——
    //    `candidatesOf` 对空 `modelId` 跳过 `modelRateLimits` 过滤，
    //    这与本家适配器（`requestLevelRotation` 关闭、不按模型换号）的语义一致；
    //    若将来接上请求级换号，这里应改为透传真实 modelId。
    resolveCredential: () => astudioCredentialPlan(''),
    // ⚠️ AstudioAdapterOptions 原本只有 product / fetchImpl / auth / resolveCredential /
    //    refresh / fetchRemoteModels / onCatalogLoaded / warn 八项 —— **没有**
    //    accountPool 与 readImage。⚠️ **但 `accountPool` 已于 2026-10-20 补上**
    //    （Gitee issue IKP8OF：缺它会让黑名单与「供应商整体关闭」静默失效，
    //    见上面那一段），故本块与它**并存**、不是二选一。
    //    仍**没有** `readImage`：实测六个模型的 input_modalities 全是 text，
    //    图片通路不成立，多传必 TS2353。
    //    ⚠️ 同样**没有** `credentialRef`：`registerAstudioLlm` 内部会用
    //    `auth.currentCredential()` 作为「池里无账号」时的回退，不需要外部传 ref
    //    （传了必 TS2353，2026-10-20 实测踩到）。
    //    ⚠️ 但「请求级换号」与「按余额分档选号」是**两件事**：前者是 429 后换号
    //    （本家确实没有），后者是「该用哪个号」（上面刚接上）。两者互不依赖。
    // ⚠️ **不传 onCatalogLoaded**：registerAstudioLlm 内部已注入唯一的
    //    broadcastCatalogChanged(ctx)，这里再传就是第二份广播。
    // ⚠️ 传 auth 即可拿到三个默认回调（currentCredential / refreshOnce /
    //    fetchCatalogModels），下面只覆盖确实需要定制的那一个。
    auth: astudio,
    product: ASTUDIO,
    refresh: async () => {
      // ⚠️ 必须返回 AstudioRefreshOutcome：本家 401 的唯一入口是 refreshOnce
      //    （**不抛**，以 credential/terminal/reason 回传），**不是**返回
      //    Promise<void> 的 refreshAccountCredential —— 后者的签名与语义都不匹配
      //    该形参（TS2322），且它会把终态错误抛进适配器。
      // ⚠️ 刷的必须是「解析凭据时所用的那一个」账号（同上面 accio 处说明）；
      //    池里没有账号时退到默认单凭据 ref。
      const available = await pool.getAvailableAccount(ASTUDIO.id, '')
      return await astudio.refreshOnce(
        available?.entry.credentialRef ?? ASTUDIO.defaultCredentialRef,
      )
    },
    warn: (message: string) => { ctx.logger?.warn?.(message) },
  })

  // ===== ModelScope（魔搭）—— **本 fork 独有** =====
  //
  // ⚠️ 迁移说明（2026-10-16）：本 provider 在 rc.3 时代按「槽制 + 自建反代」形态实现，
  //    rc.11 引入 `provider-registry` / `provider-runtime` / `credential-resolver`
  //    三套抽象后，接入点收敛到「注册表声明 + 一次 `registerProviderRuntime`」。
  //    ⚠️ **`ModelscopeAdapterOptions` 仍是槽制（`slots`）**，与 accio 的
  //    `resolveCredential` 形态不同 —— 那是有意的：魔搭的凭据是**多枚 key 轮转**
  //    （旧 fork 的 `PROXY_UPSTREAM_MODELSCOPE` 存的就是 JSON 数组），
  //    而 `createCredentialResolver` 的契约是「一个 ref 一份凭据」。
  //    详见 `src/modelscope-rpc.ts` 的 `modelscopeSlotNamesOf`。
  //
  // 服务名由 ModelscopeAuth 依 product.id 派生，注册为 ctx.modelscopeAuth。
  const modelscope = new ModelscopeAuth(ctx)
  const modelscopeAdapter = registerModelscopeLlm(ctx, {
    // 单凭据回退 ref：池里没有 modelscope 账号时用它（与其余 provider 同约定）。
    credentialRef: credentialRef(MODELSCOPE.defaultCredentialRef),
    // ⚠️ 槽序列由**接线层**解析好传进来（适配器不直接读凭据）。
    //    `modelId` 透传：接线层据此过滤「该模型正处于限流窗口」的账号
    //    （与其余 provider 的 `getAvailableAccount` 同语义）。
    slots: async (modelId?: string) => {
      const entries = await pool.listAccounts(MODELSCOPE.id)
      const usable = await Promise.all(entries.map(async (entry) => {
        // 与其余 provider 同款：停用账号不参与自动选号。
        if (!entry.enabled) return undefined
        // ⚠️ 模型级限流标记：`modelId` 缺省时**不查**（目录路径刻意不传，
        //    见适配器的模块头说明 —— 传了会让被限流的账号把整个目录拖空）。
        if (modelId !== undefined && modelId.length > 0) {
          const resetAt = entry.modelRateLimits?.[modelId]
          if (typeof resetAt === 'number' && resetAt > Date.now()) return undefined
        }
        const resolved = await ctx.credentials.resolve(credentialRef(entry.credentialRef))
        if (!resolved) return undefined
        try {
          const parsed = JSON.parse(resolved.value) as ModelscopeCredential
          if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) return undefined
          return { id: entry.id, apiKey: parsed.access_token }
        } catch {
          return undefined
        }
      }))
      return usable.filter((s): s is { id: string; apiKey: string } => s !== undefined)
    },
    accountPool: pool,
    product: MODELSCOPE,
    // ⚠️ **本 fork 独有**（2026-10-17 审计 P1 修复）：限流标记的**写入端**。
    //    ⚠️ 本回调此前**没有注入**，而上面 `slots()` 里却在**主动读**
    //    `entry.modelRateLimits?.[modelId]` 来跳过受限账号 —— 读端存在、写端缺失
    //    ⇒ 那段判据恒不命中（死代码），适配器里的 `this.options.markLimited?.()`
    //    也恒为 no-op ⇒ **限流标记永远写不进池**。
    //    守卫为什么没抓住：`provider-runtime-wiring.spec.ts` 只检查**适配器文件里
    //    有没有调用形**（`.markLimited?.(` 确实存在 ⇒ 绿），**从不检查接线层有没有
    //    注入该回调** ⇒ 「适配器写了调用、接线层没注入」这一形态打不穿。
    //    与 opencode（`index.ts:2940`）同款实现。
    markLimited: async (slotId, modelId, resetAtMs) => {
      await pool.updateModelRateLimit(slotId, modelId, resetAtMs)
    },
    // 远端目录：`GET {base}/v1/models`。失败回退 `MODELSCOPE_FALLBACK_MODELS`
    // （适配器的 `loadModelscopeCatalog` 内部兜底，不会抛）。
    // ⚠️ **必须带超时**：桌面版到外部域名的 fetch 可能永不 settle
    //（opencode 的真机事故 2026-10-02：没有超时 ⇒ listModels 永不返回 ⇒
    //  模型列表与徽标同时空白）。超时后回退兜底表，UI 立刻可用。
    fetchRemoteCatalog: (apiKey: string, signal?: AbortSignal) => fetch(modelscopeModelsUrl(MODELSCOPE), {
      headers: modelscopeHeaders(apiKey),
      signal: signal ?? AbortSignal.timeout(10_000),
    }),
    // ⚠️ **刻意不接 `readImageRequest`**：`ModelscopeAdapterOptions` 没有该字段
    //    （它按「像素预算发请求版本」的形态只在 opencode / accio 那几家实现）。
    //    魔搭的图片走 `readImage` 单一路径，逐模型按 `supportsImage` 声明模态。
    readImage: makeReadImage(ctx),
    // ⚠️⚠️ **2026-10-23 迁移：黑名单与「关闭供应商」已由共享骨架从账号池读走**
    //
    // 本家此前**手写** `listModels`，故需要在这里分别传 `disabledModels` 与
    // `providerClosed` 两个回调（2026-10-17 / IKP8OF 两次实测都栽在「漏传实参」
    // 上：适配器支持该能力、消费点也对，只是接线层漏了 ⇒ 纯静默失效）。
    //
    // 用户定稿「实体 provider 一律走共享骨架」后，那两个回调**已删除**：
    // `ModelscopeAdapter.listModels` 改为委托 `createModelCatalog`，黑名单与
    // 关闭意图统一从上面那个 `accountPool` 读。⚠️ **不要把回调加回来** ——
    // 那会让「同一语义两套判据」重现（本仓库红线），且会掩盖池没接上的缺陷。
  })

  // 一次性修复**老账号**的昵称与凭据字段（与上面 WorkBuddy 的启动清理同类）。
  //
  // 早期实现把服务端的 `name` 直接当昵称用，而实测它是**自动生成的默认名**
  //（本机账号是 `RaccoonAva`），注册第二个账号时会重名、无法区分；
  // 且凭据里没存 `phone`（后来才发现 `user_info.phone` 可用于消歧）。
  // 光改代码只影响新登录的账号，故这里主动补一次：
  // 拉 `user_info` 补 `phone`，并用 `buildRaccoonNickname` 重算昵称。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void raccoon.repairAccountNicknames(pool, buildRaccoonNickname).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 Raccoon 账号的显示名（追加手机号尾号以便区分）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 Raccoon 账号显示名失败：${String(error)}`)
  })

// ===== ZCode（智谱 z.ai 免费额度通道）=====
//
// 形态与前面所有 provider **相同**：读凭据 → 直发远端。
// 登录走**插件自己的**授权流（`zcode-login.ts`），凭据由插件写进
// `ctx.credentials`，**不读取本机 ZCode 客户端的任何数据**（2026-10-05 决策，
// 理由见 `zcode.ts` 文件头）。
//
// 与其余 provider 的三处差异（全部实测）：
//   1. 协议是 **Anthropic Messages**（不是 OpenAI 兼容）——
//      见 `zcode-anthropic.ts` 的转换层。
//   2. captcha **按需**产出（默认不带验证头探一次，被 `3007` 拒才 mint，并按
//      「账号 × 模型」记 2 分钟）—— 见 `zcode-captcha.ts` 与 `captcha-requirement.ts`；
//      mint 的耗时口径与「上游并非每次都要验证」的实测见 README 的 ZCode 章节。
//   3. 请求体必须带官方身份块与首轮日期块，否则上游回 `3012` ——
//      见 `zcode-identity.ts`。
//
// ⚠ **完全可脱离官方客户端使用**：登录走官方 CLI 设备授权流
// （`/oauth/cli/init` → 浏览器授权 → `/oauth/cli/poll/{flow_id}`，
// 纯 HTTP，见 `zcode-login.ts`），且 `device_mid` **由插件自己生成**。
//
// ⚠ **不可续期**：凭据是静态的（JWT 的 payload 里没有 `exp`）。
// 失效时上游回 401/1002，适配器归为 AUTH 并提示用户重新登录。
//
// 服务名注册为 ctx.zcodeAuth（由 `Service` 基类完成）。
// 不注册斜杠命令：入口在 大肥鱼饭碗 的 ZCode 面板。
//
// ⚠ **必须把账号池传进去**：`ZcodeAuth.current()` 要从账号池里找用户在
// 大肥鱼饭碗 登录时创建的那个 ref（`ZCODE_ACCOUNT_XXXX`），而不是只认固定的
// `ZCODE_CREDENTIAL`。不传的话「登录成功但面板显示未配置」。
const zcode = new ZcodeAuth(ctx, {
  accountPool: pool,
  /**
   * ★ 二期内部载体（`src/captcha-carrier.ts`）的诊断日志。
   *
   * 那两条告警（「内部载体的 param 被上游拒（第 N 次）」「累计拒 3 次 ⇒ 本次运行禁用
   * 内部载体」）是排查「内部载体为什么没起作用 / 为什么被自动关掉」的**唯一**线索，
   * 缺省不接就等于线上什么都看不见。
   * ⚠ 取 logger 用两级可选链（同文件既有的 `log` / `makeReadImageRequest` 写法）：
   *   宿主某些形态不给 logger，写成点号直调会让调用点所在的产出路径抛 TypeError。
   */
  carrierLog: (message: string) => {
    ctx.logger?.warn?.(message)
  },
})
/**
 * captcha 配置：优先向服务端索取，失败回退内置兜底值。
 *
 * ## ⚠ 这里**不再**做缓存（2026-10-01 修正）
 *
 * 旧实现是 `??=` 的**永久缓存**，两个缺陷（都已实测确认）：
 *
 * 1. **服务端换 `sceneId`／灰度切换后永不生效**（必须重启宿主才能跟上）；
 * 2. **首次拉取失败会被永久固化** —— `??=` 连「回退到兜底值」这个结果
 *    一起记住，此后即使服务端恢复也不会重试。
 *
 * 正确做法是官方 `f3()` 的语义：**60 秒 TTL + 在飞去重、失败不缓存**。
 * 那个能力已下沉到 `ZcodeAuth.fetchCaptchaConfig()`
 *（见其 `captchaConfigCacheInstance`），故这里只做「拿 → 回退」的编排。
 */
const resolveZcodeCaptchaConfig = async (): Promise<ZcodeCaptchaConfig> => {
  const remote = await zcode.fetchCaptchaConfig().catch(() => undefined)
  if (remote !== undefined) {
    zcodeAdapter.setCaptchaConfig(remote)
    return remote
  }
  return ZCODE_CAPTCHA_FALLBACK
}
/**
 * 「本次 ZCode 请求**实际使用**的账号 id」。
 *
 * ## 为什么需要（与 `activeQoderAccountId` 同因）
 *
 * 额度受限时适配器要**标记失败的账号**，而它能拿到的只有这个回调。
 * 池的选号是即时决策，且**切号后回调不会跟着变** —— 若适配器改用
 * 「池当前的默认账号」，切到 B 之后失败时会**再标记一次 A**，
 * B 从未被标记，下次取号又把 B 选中，于是在 A/B 之间反复空转
 * （`qoder-adapter.ts` 的 `switchAccountOnQuota` 注释里记了这条实测）。
 *
 * ⇒ 在 `resolveCredential` 里记录**实际返回的那个账号**，供适配器查询。
 */
const activeZcodeAccountId = new Map<string, string | undefined>()
const zcodeAdapter = registerZcodeLlm(ctx, {
  credentialRef: credentialRef(ZCODE.defaultCredentialRef),
  resolveCredential: createCredentialResolver<ZcodeCredential>(
    {
      pool,
      /**
       * ⚠️ `undefined` 是**有意义的事件**：账号池里没有条目时要**清空**记录，
       * 留着旧 id 会误伤一个无辜账号（见 `activeZcodeAccountId` 的说明）。
       */
      reportAccount: (id) => {
        activeZcodeAccountId.set(ZCODE.id, id)
        if (id !== undefined) reportLedgerAccount(ZCODE.id, id)
      },
    },
    {
      // 只从 zcode 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 ZCODE 而非字面量：写死字面量在改名/多产品场景下
      // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      // ⚠ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
      product: ZCODE,
      // ⚠️ zcode 的 `readCredential` **用不到**（它的兜底是下面的 `custom`，
      // 既不做余额分档、也不按 ref 读）。传一个恒 `undefined` 的实现而不是把它
      // 改成可选：可选会让「忘了传」在编译期无声通过，而那正是 TRAE 注释里记的坑。
      readCredential: async () => undefined,
      /**
       * ⚠️ 落到 `ZcodeAuth.current()` —— 它已经实现了「账号池 → 单凭据 ref」
       * 的解析顺序。**不要**在这里重复实现那条优先级（重复必然漂移）。
       *
       * ⚠️⚠️ **刻意不接 `throwIfAllAccountsRateLimited`** —— 与 IKJOZ9 修好的
       * 那批 provider 相反。
       *
       * ⚠️ **刻意不写「几家」**：本句原写「那 8 家」（写这句话时的快照），
       * 后又改成「那 10 家」—— **两个数都不对**（实测接线处 = **11**，
       * 与 `buddy-ratelimit-misreport.spec.ts` 的 `WIRING` 表逐一点名的
       * 11 家一致）。这类「家数」是**必然腐坏**的快照：每新增一家就会失效，
       * 而「数字对不上」会让人怀疑整段约定。
       * ⇒ 名单的**唯一权威**是那张 `WIRING` 表（漏一家会点名），
       * 本注释只留「那批」。
       *
       * 其余各家的兜底是读一个在 大肥鱼饭碗 登录路径下**从不被写入**的 `*_ACCESS_TOKEN`，
       * 于是「池被限流筛空」必然一路退化成 `undefined` → 适配器误报「请先登录」
       * —— 那才是 IKJOZ9 的症状。
       *
       * zcode 的兜底 `current()` 却会**再读一次账号池**
       *（`zcode-auth.ts` 的 `readStoredCredential` → `readCredentialFromPool`），
       * 且既不看 `enabled`、也不看 `modelRateLimits` ⇒ 池被筛空时它**照样返回凭据**。
       *
       * 实测（2026-10-06，真实 `apply()` + 真账号池，临时探针）：
       *   · 唯一启用账号被限流、凭据合法 → **返回该凭据**，不抛「未登录」；
       *   · 池里还有一个「停用但健康」的账号且**排在前面**（`readCredentialFromPool`
       *     取数组序第一个能解析的）→ **返回那个停用账号的凭据**，请求能跑通。
       *
       * ⇒ ① zcode 没有 IKJOZ9 的症状，不该被"顺手修"；② 在第二种组合下，
       * 加判定反而会把本来能跑通的一发变成硬失败。故保持原样。
       * 回归断言见 `buddy-ratelimit-misreport.spec.ts` 的「zcode 同型缺陷判定」段。
       */
      fallback: { kind: 'custom', resolve: async () => await zcode.current() },
    },
  ),
  refresh: async () => {
    /**
     * ⚠ ZCode **没有** refresh 端点（与 Loomy 恒 false 同类，但原因不同）：
     * 凭据是**静态**的（登录一次就固定下来，JWT 里没有 `exp`）。
     *
     * 这里做的是「重读凭据并回写账号条目」，让用户重新登录后不重启即可生效。
     *
     * ⚠⚠ **绝不能用 `current()` + `getAvailableAccount()` 的组合**（审查发现的
     * 真实缺陷，与 `refreshAll` 里记录的那个数据破坏同类）：`current()` 会**先读池**
     * 且**不看 `enabled`**（它按数组顺序取第一个能解析的），而 `getAvailableAccount`
     * **会过滤 `enabled`** —— 两者选的可能是**不同账号**，于是「把 A 的凭据写进 B 的
     * ref」，30 分钟一轮就会串掉整池。
     * 正确做法是交给 `refreshAll`：它逐账号读**自己的** ref、写回**自己的** ref。
     */
    await zcode.refreshAll(pool)
  },
  // ⚠ captcha 是**一次性**的 —— 每次调用都必须现产一个新 param。
  // 走 `zcode.mintCaptcha`：整个插件**共用一台**常驻浏览器
  //（适配器自建会变成两台，白占 200MB）。
  //
  // ⚠ `options.signal` 必须继续往下传：captcha 侧的取页等待与建连历史上有
  // 无超时的路径，不传就等于「用户点停止也停不下来」（真实缺陷，2026-09-29）。
  mintCaptcha: async (options?: { signal?: AbortSignal }) => {
    const config = await resolveZcodeCaptchaConfig()
    return await zcode.mintCaptcha(config, options)
  },
  /**
   * ★ 二期内部载体：推理热路径取 param 走**载体链**（内部供给槽优先，等不到才落
   * 上面那条 chromium 链）。与 `mintCaptcha` 的差别只有「返回值带来源」这一层。
   *
   * ⚠ 这两条回调**必须都在**：少接一条，被 `3007` 拒的那一发就退回普通入口重新取，
   *   归因（内部 vs chromium）就此丢失 —— 累计拒绝到阈值的自动禁用也就永远到不了。
   * ⚠ 载体链不可用（`DSH_ZCODE_INTERNAL_CARRIER=0` / web 版从未收到贡献）时
   *   `zcode.mintCaptchaParam` 自己会退回那条 chromium 链 ⇒ 这里不需要判断开关。
   */
  mintCaptchaParam: async (options?: { signal?: AbortSignal }) => {
    const config = await resolveZcodeCaptchaConfig()
    return await zcode.mintCaptchaParam(config, options)
  },
  mintCaptchaAfterRejection: async (
    outcome: CarrierOutcome,
    options?: { signal?: AbortSignal },
  ) => {
    const config = await resolveZcodeCaptchaConfig()
    return await zcode.mintCaptchaAfterRejection(outcome, config, options)
  },
  /**
   * captcha 的 region —— **只是「连配置都没有」时的最后兜底**，正常路径不生效。
   *
   * ⚠ region 必须与产 param 的那份配置同源（真实缺陷，Gitee issue IKJNPS；
   *   领取路径与推理路径各有一个实例）。上面三个 mint 回调都会走
   *   `resolveZcodeCaptchaConfig()`，它把远端配置写进适配器
   *   （`setCaptchaConfig`）⇒ 组头时适配器读的是 `captchaConfig.region`，
   *   这里这个字面量只在自建浏览器那条腿（没有任何注入回调）且从未拉到配置时兜底。
   *
   * ⚠ 别把它写回「无条件生效」——服务端下发的 region 因账号/渠道而异
   * （作者账号是 `cn`，z.ai 国际渠道实测 `sgp`），写死只会在 cn 区账号上碰巧正确。
   */
  captchaRegion: ZCODE_CAPTCHA_FALLBACK.region,
  /**
   * 诊断日志：把「先探后取」的前置耗时与补产事件接到宿主 logger。
   *
   * ⚠ **必须注入** —— 适配器里那三条出口（`zcode-adapter.ts` 的
   * `前置耗时 …`、`上游要求 captcha（3007）…`、`captcha 被拒（3007），换新 param 重试`）
   * 全走 `this.options.log?.()`，缺省**完全不输出**（见 `ZcodeAdapterOptions.log`
   * 的注释）。不接上就是：带 captcha 的那一发比不带的慢一次 mint（稳态约 0.4–0.5
   * 秒、首次含 chromium 冷启动 4.2 秒；口径见 README 的 ZCode 章节）在外部**没有任何可看的证据**
   * —— 「先探后取到底生效没有」只能靠猜。
   *
   * ⚠ 取 logger 用可选链 `?.info?.()`：与同文件既有防御写法一致
   * （`makeReadImageRequest` 的降级告警、`refreshAllCredentials` 的批量续期告警
   * 都是 `ctx.logger?.warn?.(...)`）。宿主没给 logger 时**静默**，
   * 绝不能在推理路径上抛错。
   */
  log: (message: string) => {
    ctx.logger?.info?.(message)
  },
  /**
   * ⚠ **图片字节桥接** —— 这是图片能真正发出去的关键。
   *
   * DSH 的图片块只带 `attachment:{attachmentId}`，真正拿字节要经附件服务。
   * 缺了这两项，`serializeMessages` 拿到**空映射**，图片会退化成
   * `[image unavailable]` 占位符 —— 实测症状是模型回
   * 「我在当前对话中没有收到任何图片」。
   *
   * ⚠ 与其余 provider 同款约定（十余处一致）：
   *   - `readImage`：拿原始字节（内联为 data URL）
   *   - `readImageRequest`：拿**按预算缩放后**的字节；**不可用时返回
   *     `undefined`**（不抛错），适配器据此回退原图
   */
  readImage: makeReadImage(ctx),
  // 图片请求版本（缩放）桥接：ZCode 免费通道的请求体没有实测硬上限，
  // 但 base64 后的截图很大（2560×1600 各约 3.9 MB），两张就接近常见网关
  // 的 10MB 门槛 —— 与 raccoon 的同因（issue !IKITT9 那一族）。
  readImageRequest: makeReadImageRequest(ctx),
  // ⚠️ **字节目标必须显式传**（2026-10-12 修）：适配器读 `options.imageMaxBytes`，
  // 缺省时 `requestImageTargetFor` 会回退到 **2 MiB**（那是为腾讯系的图片 token
  // 预算准备的），而 ZCode 撞的是**请求体体积**（见上面那条注释里的 10MB 门槛）。
  // 与四家 product 的同款缺陷/修法一致（见 `image-budget.spec.ts` 的守卫用例）。
  imageMaxBytes: DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES,
  // 模型目录用静态白名单（实测可用的两个）—— 上游模型池含
  // 实测返回空响应的两条（GLM-5-Turbo / GLM-5.2），故不枚举远端。
  fetchRemoteModels: () => zcode.fetchRemoteModelsOnly(),
  accountPool: pool,
  product: ZCODE,
  // 就绪判据 = 有可用凭据（插件自存的）。
  isReady: async () => (await zcode.current()) !== undefined,
  /**
   * 额度用尽 / 无权益时，适配器据此**标记失败的账号并切换**。
   *
   * 回调的是「本次实际使用的账号」（理由见 `activeZcodeAccountId` 的注释）——
   * 不要改成 `pool.getAvailableAccount(...)` 之类「再问一次池」的实现。
   */
  currentAccountId: () => activeZcodeAccountId.get(ZCODE.id),
})

/**
 * ⚠ **必须用 `fetchRemoteModelsOnly()` 而不是 `fetchModels()`**（来自 PR #31
 * `05e4ad7`，保留其与桥无关的部分；本地桥 `zcode-bridge.ts` 已随 PR #29 的
 * 过时方案一并弃用，故这里只剩适配器这**一个**消费点）。
 *
 * 为什么必须有这条：适配器判「这次拿到目录了吗」的判据是「返回空数组」。
 * 若接线用 `fetchModels()`（失败时回吐兜底表），那个判据**永不命中**
 * ⇒ 兜底表被当成远端结果写进 `remoteModels` 并永久缓存，用户登录 /
 * 网络恢复后**再也不会重拉**（连失败冷却都不会开），只能重启 DSH。
 * 「回退兜底表」这件事只应由**展示侧**（适配器）做一次。
 *
 * ## 为什么不接本地桥（原 PR 的说明，保留供日后参考）
 *
 * 原 PR 让 ZCode 同时走一条「官方 pi-ai 声明式 provider + 本地 Anthropic
 * 透明桥」的镜像 route（`zcode-free`），其核心假设是「每个请求必须现产
 * captcha」。该假设已被 master 的大重构（`19226ca`）推翻：ZCode 3.14.4 起
 * **推理不再校验 captcha**，只有领取才要 —— 桥每请求白产一个，白烧设备级
 * 验证配额（阿里云同设备 150 次/小时）。故**只保留**「目录拉取不污染缓存 +
 * 自愈两闸 + 写盘串行化」这些与桥无关的修复，桥与镜像整个弃用。
 */

  // 一次性修复**老 TRAE 账号**的展示名（与上面 Raccoon 同类，同因）：
  // 服务端 ScreenName 是**按 uid 自动生成的默认名**（`用户26815487395`），
  // 多账号无法区分；`GetUserInfo` 的 `NonPlainTextMobile`（脱敏手机号）可区分。
  // 光改代码只影响新登录的账号，故这里主动补一次。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void trae.repairAccountNicknames(pool).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 TRAE 账号的显示名（改用脱敏手机号以便区分）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 TRAE 账号显示名失败：${String(error)}`)
  })

  // 一次性修复**老 LobsterAI 账号**的展示名（同类，但成因不同）：
  // 服务端把**手机号本身**当 `user.nickname` 下发，且只脱敏到「露末 4 位」
  // （`130****1100`）—— 按用户要求收敛为只露末 2 位（`130******00`）。
  // 纯本地归一化（幂等），无需重新登录。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void lobsterai.repairAccountNicknames(pool).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 LobsterAI 账号的显示名（手机号改为只露末 2 位）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 LobsterAI 账号显示名失败：${String(error)}`)
  })

  // 一次性修复**老 Gemini 账号**的展示名（同类，成因见 `gemini-auth.ts` 的
  // `repairAccountNicknames`）：旧版本解析令牌响应时丢掉了 `id_token`，身份只剩
  // userinfo 一次可静默失败的跨域请求，失败即让昵称退化成池 id（`gemini-6a53dbca`）。
  // 光改代码只影响新登录的账号，故这里主动补一次。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void gemini.repairAccountNicknames(pool).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 Gemini 账号的显示名（改用 Google 账号邮箱）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 Gemini 账号显示名失败：${String(error)}`)
  })

  // 一次性修复**老 MiniMax 账号**的展示名（Gitee issue IKP8UA 修法 ③）。
  //
  // 成因见 `minimax-auth.ts` 的 `repairAccountNicknames`：MiniMax 的
  // `access_token` **不是 JWT**，而旧昵称判据走 `decodeJwtSub` ⇒ 恒空 ⇒
  // 账号卡片恒显示插件内部 id（`minimax-6395cf64`），多账号无法分辨。
  // 光改登录路径**不会自愈存量账号**（本机实测 7 条全是内部 id），故补这一次。
  //
  // ⚠️ 两个站点**各一条**（它们共用同一个 auth 类、但 product 不同 ⇒
  //    `apiHost` 与 XFF 判据都不同，见 `minimax-identity.ts`）。
  //    漏一处即该站静默不自愈（本仓库的既有纪律：双站点每处都要到位）。
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void minimax.repairAccountNicknames(pool).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 MiniMax 账号的显示名（改用上游账号名）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 MiniMax 账号显示名失败：${String(error)}`)
  })

  void minimaxIntl.repairAccountNicknames(pool).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 MiniMax 国际版账号的显示名（改用上游账号名）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 MiniMax 国际版账号显示名失败：${String(error)}`)
  })

  // ===== 多账号静默续期调度 =====
  // 替代原有的单账号 scheduleRefresh()，使用 refreshAll() 遍历所有账号续期
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000  // 每 30 分钟检查一次

  /**
   * 十三个 provider 实例的续期入口（`buddy` 与 `workbuddy` 是两个实例、同一个类；
   * `qoder` 与 `qodercn` 同理）。
   *
   * ⚠️ 条数会随 provider 增长（早期写「十个」已过时）——注释里的数字**不是**契约，
   * 派生的键集合才是（见 `wiredRefreshTargets`）。
   *
   * 收成一张表是为了让「失败必须留日志」这条规则**只写一遍** —— 原先这里是
   * 十个空 catch（注释写着「静默」），把 provider 内部的告警与异常一起吞掉，
   * 「凭据一直刷不动」在日志里完全无痕（issue !IKIRTT 的可观测性条目）。
   *
   * ## ⚠️⚠️ 2026-10-08（Task 10）：改为**从能力注册表派生**，且**惰性求值**
   *
   * 原先这里**手抄 13 行**。失效形态极隐蔽：**漏一家 ⇒ 该家凭据永不自动续期**，
   * 而症状只是「每隔一段时间就要重新登录」，**日志里一个字都没有**。
   *
   * ⚠️ **必须是函数调用而不是在这里立即求值**：本行（`apply()` 中段）在
   * **注册循环之前**执行，而注册循环在 `apply()` 的**末尾**。立即求值会得到
   * **空表** ⇒ 所有 provider 都不再自动续期，而日志里只有 `isPoolEmpty`
   * 的常规输出。
   *
   * ⇒ 改为在 `refreshAllCredentials` **内部**每次调用时现取（见下）。
   * 代价是一次极廉价的 Map 遍历；收益是**与注册时机彻底解耦**。
   *
   * ⚠️ **与被删清单里的注释的关系**（2026-10-08 独立复审修正）：原先手抄的 13 行
   * 各自带注释，删除时它们被**压缩成本函数上方这段 5 项摘要**（不是「逐条上移到
   * `probeById` / `wiredRefreshTargets` 侧」—— 实测那两个符号处对这些家零命中）。
   * 摘要保留的 5 个失效模式（**不得静默丢弃**，Task 6 的主导失效类）：
   * Loomy 不可续期（只探测已过期）、raccoon 的 lead 窗口、minimax 的
   * refresh_token 轮换、zcode 静态凭据仍回写、gemini 漏挂的后果。
   * ⚠️ 其中 gemini 那条的**后果措辞已过时**：定时器自 issue IKJOZB 起已改为
   * **无条件武装**（只看池里有没有账号，不看续期表的成员资格）⇒ 漏挂 gemini 的
   * 真实后果是「**gemini 凭据永不自动续期**」，**不是**「定时器不武装」。
   */
  async function refreshAllCredentials(): Promise<void> {
    // ⚠️ **每次现取**（wiredRefreshTargets() 是函数、读注册表）：注册发生在
    //    apply() 末尾，而本函数最早在调度器 start() 的首轮就被调用 ⇒
    //    若在这里读一个**在注册前求值的常量**，会得到**空表** ⇒
    //    所有 provider 都不再自动续期，而日志里只有 isPoolEmpty 的常规输出
    //    （⚠️ 注意 WIRED_EXPIRY_PROVIDERS **不属**这一类：它是刻意保留的纯数据清单，理由见 `aggregate-expiry.ts` 自己的注释。）
    for (const [tag, refreshAll] of wiredRefreshTargets()) {
      try {
        await refreshAll(pool)
      } catch (error) {
        // 单个 provider 抛错不得中断其余九个（各 refreshAll 内部本就逐账号
        // try，能冒到这里的已是「整批失败」级别的异常）。
        ctx.logger?.warn?.(
          `[jet-hub] ${tag} 批量续期失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  // 启动时**无条件**武装续期调度器，并在账号入库时补一次武装。
  //
  // ⚠️ 空池判据（`isPoolEmpty`）**只用于日志措辞**，不再参与「是否武装」的决策。
  // 它的历史形态是「按 `accounts.some(a => a.refreshable)` 决定武装」——
  // 那让这个定时器**是否武装**取决于一批可能已被误标成 false 的布尔，而它存在
  // 的意义恰恰是去修正误标。本次事故实测：36 条账号只剩 3 条 `true`
  // （raccoon / minimax / cline 各一），只要那三条被删或被同样误标，
  // **codearts 的自愈与启动首轮会一起消失**，且日志里一个字都不会有。
  // 各家 `refreshAll` 内部本来就按凭据材料 / 是否过期过滤（`loomy` 只探已过期的、
  // 其余看 `refreshableOf(credential)`），故放宽判据最多多一次本地遍历。
  //
  // ⚠️ 仍然**不看 `enabled`**（AGENTS.md 既有铁律）：停用只影响自动选号，
  // 不该让凭据停止续期。早期写成 `a.refreshable && a.enabled`，于是
  // 「所有账号都被停用」时续期定时器根本不启动，凭据一路烂到 refresh_token 失效。
  //
  // ⚠️⚠️ **更不能因为「启动瞬间池为空」就不武装**（issue IKJOZB 的真实缺陷）：
  // 冷启动空池是正常态（新用户、刚清过存储），而原先的 `if (accounts.length === 0)
  // return` 让整个调度器**不被创建**、之后又没有重新武装的路径 ⇒ 该会话内登录的
  // 账号**永远不会被主动续期**（只剩请求内按需续期），凭据悄悄过期而面板仍显示
  // 「可自动续期」，且日志里一个字都没有。
  // 现在武装与池内容彻底解耦（见 `src/refresh-scheduler.ts`）：
  // ① 无条件武装；② 定时器内空池只记日志、下轮继续；③ `pool.onAccountAdded`
  // 提供「入库即补武装」这条 issue 点名缺失的路径。
  //
  // ⚠️ **必须立刻先跑一轮**（issue !IKIRTT 的主缺陷，已内建在 `start()` 里）：
  // 早先这里只有 `setInterval`，第一次处理要等满一个周期。短寿命 provider
  // （cline 1 小时、codearts 约 2 小时、raccoon 3 小时）的凭据在宿主关闭期间
  // 早就到期了，于是重启后**最长 30 分钟**一直显示「已过期」、积分行一直 401。
  // 这一轮与 lead-time 过滤配合（`src/expiry-sync.ts` 的 `shouldRefreshNow`），
  // 只对「距过期不足 1 小时」的账号发续期请求，其余只做一次本地对账 ——
  // 既补上了首轮，又不会在启动时打出几十个无谓请求。
  const refreshScheduler = new MultiAccountRefreshScheduler({
    refresh: refreshAllCredentials,
    intervalMs: REFRESH_INTERVAL_MS,
    isPoolEmpty: async () => (await pool.listAllAccounts()).length === 0,
    // ⚠️ 可选链：`logger` 在极简 profile 下可能缺席，而日志不该成为续期的
    // 单点故障（与仓库既有的 `ctx.logger?.warn?.()` 一致）。
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
  })
  // ⚠️ 不 await：`apply()` 是同步函数，而 `start()` 内含首轮续期（会发网络请求，
  // 可达数十秒）。阻塞在这里会让插件启动卡住（与 opencode 能力预热同款约定）。
  void refreshScheduler.start().catch((error: unknown) => {
    // 走到这里说明 `refresh()` 或订阅通知本身出了意料之外的异常；`onTick`
    // 内部已消化常规失败，故这条只是最后一道可观测性兜底。
    ctx.logger?.warn?.(
      `[jet-hub] 多账号续期调度器启动失败（本次会话不会自动续期）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  })
  // issue IKJOZB 点名缺失的那条「重新武装的路径」：账号入库（登录成功、导入、
  // 恢复备份）时若调度器未武装则补上。⚠️ 订阅点必须挂在 `AccountPool` 上，
  // 不能逐个登录流程接线 —— 全仓库十几处 `pool.addAccount` 调用点，漏一处
  // 就意味着那个 provider 静默地永不续期。
  //
  // ⚠️ **同时清空临期折算缓存**（真实缺陷，对抗审计实测证伪）：缓存原先**没有
  // 任何失效通道** ⇒ 刚登录（或限流刚解禁）的账号在**最长 60 秒内对路由不可见**，
  // 用户拿到误导性的 `MISSING_CREDENTIAL | …没有任何可用候选`（明明刚登录成功）。
  // ⚠️ 用**可变引用**（`let sharedExpiryProbeRef`）而不是直接捕获 `const` ——
  // 探针定义在**本订阅之后**（那里才够 `ctx.llm` 注册完 provider），
  // 闭包直接引用会命中 TDZ。
  let sharedExpiryProbeRef: { clear: () => void } | undefined
  const unsubscribeAccountAdded = pool.onAccountAdded(() => {
    refreshScheduler.notifyAccountAdded()
    // ⚠️ 未定义时什么都不做（订阅可能在它们建好前就触发 —— 那是正常时序）。
    sharedExpiryProbeRef?.clear()
  })
  ctx.effect(() => () => {
    unsubscribeAccountAdded()
    refreshScheduler.stop()
    service.stop()
    buddy.stop()
    workbuddy.stop()
    lobsterai.stop()
    qoder.stop()
    qoderCn.stop()
    trae.stop()
    cline.stop()
    loomy.stop()
    zcode.stop()
    // ⚠ 必须 dispose captcha 浏览器 —— 否则会留下孤儿 chromium
    //（约 200-400 MB，且用户没有界面能关掉它）。
    zcodeAdapter.stop()
    // AStudio（讯飞）的 stop() 置 active=false，阻止在途刷新回写凭据。
    astudio.stop()
  }, 'jet-hub: multi-account refresh scheduler')

  // 保留旧的 stop scheduler（兼容旧命令）
  ctx.effect(() => () => {
    service.stop()
    buddy.stop()
    workbuddy.stop()
    lobsterai.stop()
    qoder.stop()
    qoderCn.stop()
    trae.stop()
    cline.stop()
    loomy.stop()
    zcode.stop()
    // 同上：captcha 浏览器必须随插件一起回收。
    zcodeAdapter.stop()
    // 同上：AStudio 的在途刷新必须随插件一起回收。
    astudio.stop()
  }, 'codearts-auth.scheduler (legacy)')

  // ===== OfficeAce（华为 ModelArts MaaS，云端直连）=====
  //
  // 形态与前面所有 provider 相同：进程内 LlmAdapter 直发远端，无子进程、无端口。
  //
  // 独有语义：**凭据完全自主** —— 登录走华为云 OAuth（PKCE + DPoP），推理用
  // `model_app_key:secret` 的 Basic 鉴权，STS 用 refresh_token 续期（30 天），
  // 积分余额与倍率经 V11 签名直读云侧。全程**不经过 OfficeAce 客户端**
  //（协议逆向见 `officeace-auth.ts` 模块头）。
  /**
   * 「启用中的 OfficeAce 账号」清单（**顺序 = 用户拖拽的手动优先级**，与
   * `getAvailableAccount` 的候选序同一份）。
   *
   * ⚠️ 锁定判定（逐账号看余额）与未锁定取号（取第一个）**必须共用这一份**：
   *    各写一遍会让「锁定遍历了谁」与「未锁定用了谁」悄悄漂移 —— 而
   *    `officeace-refresh-all.spec.ts` 的调用点普查刻意「新增即红」，正是要求
   *    每新增一处取池都要先证明它**不是第二份遍历**。这里抽成一处即为此
   *    （纯重构 ⇒ 那个普查的调用点计数**保持不变**）。
   */
  const enabledOfficeAceAccounts = () => pool.listAccountsByProvider(OFFICEACE.id)
    .filter((entry) => entry.enabled !== false)

  /**
   * 「不理会锁定」的取号路径 = **锁定前的那条原路径，逐字保留**。
   *
   * 两个用途（**同一份实现**，刻意不写第二份）：
   * 1. 未锁定态的推理取号 —— 即 `credentialProvider` 的 `resolveUnlocked`；
   * 2. **只读目录探测**（`/v2/models` + 倍率）—— 它们不扣积分，**绝不能被锁定
   *    牵连**（否则面板报「读取模型列表失败」、供应商关不掉、分组消失）。
   */
  const resolveOfficeAceCredential = async () => {
    const available = await pool.getAvailableAccount(OFFICEACE.id, '')
    const ref = available?.entry?.credentialRef
      ?? enabledOfficeAceAccounts()[0]?.credentialRef
    if (ref === undefined) return officeaceAuth.readStoredCredential()
    return officeaceAuth.readCredential(ref, ctx.credentials as never)
  }

  const officeAceAdapter = registerOfficeAceLlm(ctx, {
    // ⚠️⚠️ **2026-10-23 迁移：黑名单与「关闭供应商」已由共享骨架从账号池读走**
    //
    // 本家此前**手写** `listModels`，故需要分别传 `disabledModels` / `providerClosed`
    // 两个回调（IKP8OF 那次就是靠这两行兜住的）。用户定稿「实体 provider 一律走
    // 共享骨架」后，那两个字段**已删除** —— 现在唯一入口是本行传进去的池。
    // ⚠️ **不要把它们加回来**：那会重现「同一语义两套判据」（本仓库红线）。
    accountPool: pool,
    // ⚠️ **按当前选中账号的 ref 取凭据**（2026-10-13）：凭据存在 DSH 凭据库里
    //    按 `credentialRef` 索引（与 gemini / raccoon 同款）。缺省会读兼容文件
    //    `session.json`，那份是**所有账号共用**的 ⇒ 号池轮换形同虚设。
    //
    // ⚠️⚠️ **锁定态必须在这里分道**（Gitee issue IKLTHB 第 ① 条，2026-10-12 起
    //     一直是哑锁）：`permanentLocked()` 在全仓只有 `credential-resolver.ts`
    //     的 buddy / loomy 两个分支读过，而 officeace 走的是**适配器自己的**
    //     `credentialProvider` ⇒ 面板上那个开关写进了 `permanent-locks.json`
    //     却没有任何执行代码。判定逻辑全部在 `officeace-lock.ts`（纯函数 + 注入），
    //     这里只负责装配：**未锁定态逐字保留原路径**（即上面那份
    //     `resolveOfficeAceCredential`），锁定态**绝不回落池**。
    credentialProvider: createOfficeAceCredentialProvider({
      permanentLocked: () => pool.permanentLocked(OFFICEACE.id),
      // 锁定判定要**逐账号**看余额 ⇒ 取全部启用账号（与未锁定取号同一份清单）。
      accounts: () => enabledOfficeAceAccounts()
        .map((entry) => ({ id: entry.id, credentialRef: entry.credentialRef })),
      resolveUnlocked: resolveOfficeAceCredential,
      readCredential: (ref) => officeaceAuth.readCredential(ref, ctx.credentials as never),
      readStoredCredential: () => officeaceAuth.readStoredCredential(),
      // ⚠️ **必须带 ref**（云侧 V11 直读；缺了会回落果办客户端的全局单 cookie
      //    ⇒ 多账号判成同一份余额 ⇒ 按错误的余额决定「能不能烧永久积分」）。
      summaryOf: async (credential, ref) => {
        try {
          const summary = await officeaceAuth.fetchSubscriptionSummary(48, ref, credential)
          return summary === undefined
            ? { ok: false, error: '读不到订阅摘要（未登录 / 云侧查询失败）' }
            : { ok: true, summary }
        } catch (error) {
          return { ok: false, error: `订阅摘要查询失败：${String(error)}` }
        }
      },
    }),
    // ⚠️ **目录探测必须绕开锁定**（Gitee issue IKLTHB 第 ① 条的自查连带发现）：
    //    `credentialProvider` 在「锁定 + 只剩永久桶」时会抛错，而
    //    `listModels` 的调用方全都不接这个错（`dsh-llm` 直接 `await`）⇒
    //    症状是一串与锁定无关的：面板「读取模型列表失败」、`关闭供应商` 被
    //    `remoteError` 拒、聚合静默少一个候选、模型选择器分组消失。
    //    只读端点不扣积分，没有理由被锁定牵连；见适配器 `probeCredential` 的表。
    probeCredential: resolveOfficeAceCredential,
    // ⚠️ **图片输入桥**（2026-10-13）：deepseek-v4.1-flash / kimi-k2.6 实测支持
    //    多模态（1×1 PNG 探针通过）。漏接 = 用户发图后适配器报
    //    「需要附件服务」—— 图根本到不了模型。
    readImage: makeReadImage(ctx),
    // ⚠️ **必须注入**（同其余渠道）：宿主在「登录 / 点刷新积分」等时机调它把新凭据
    //    拉进来。漏接的症状是该渠道的账号永不过期 —— 用户重新登录后旧凭据仍被
    //    继续用，且日志里一个字都没有。
    // ⚠️ **必须走账号池**（与 gemini 同款，守卫用例断言）：OfficeAce 只有一个账号
    //    条目，但仍要先按 `getAvailableAccount(provider, '')` 从池里取 ——
    //    「池筛掉后回落到单凭据 `refresh()`」正是被 `trae-model-id-selection.spec.ts`
    //    断言禁止的失效形态（那个用例的判据是「续期拿到的 ref === 被限流账号的 ref」）。
    refresh: async () => {
      // ⚠️ 必须走账号池（与 gemini / loomy 同款，守卫用例断言）：OfficeAce 只有
      //     一个账号条目，但仍要从池里取 —— 「池筛掉后回落到单凭据 `refresh()`」
      //     正是 `trae-model-id-selection.spec.ts` 明文禁止的失效形态（判据是
      //     「续期拿到的 ref === 被该模型限流的那个账号的 ref」且 fallback 计数为 0）。
      const available = await pool.getAvailableAccount(OFFICEACE.id, '')
      if (available) {
        await officeaceAuthService.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
        return
      }
      // ⚠️ 池被限流标记筛空时**不能回落 `refreshAll`**：那会让被限流的账号
      //    永远等不到续期（issue 的核心）。改为从池里直接取**第一个启用账号**。
      // ⚠️ `listAccountsByProvider` 是**同步**返回数组（不是 Promise）——
      //    给它接 `.catch()` 是类型错误。
      const all = pool.listAccountsByProvider(OFFICEACE.id)
      const first = all.find((entry) => entry.enabled !== false) ?? all[0]
      if (first !== undefined) {
        await officeaceAuthService.refreshAccountCredential(
          first.credentialRef, pool, first.id,
        )
        return
      }
      // 池里真的没有账号（尚未登录）⇒ 才允许续期那一份本机凭据。
      await officeaceAuth.refreshStoredCredential().catch(() => undefined)
    },
    // ⚠️ 必须注入：DSH 的模型目录是**推送式**的（客户端把 catalog 缓存在
    //    `status === 'ready'` 的短路 store 里，只在收到 `llm/adapters-updated`
    //    等事件时才重读）。不广播 = 注册成功、`listModels` 也正常，但模型选择器
    //    里**看不到分组**（真实症状 2026-10-12）。
    onCatalogLoaded: () => { ctx.emit('llm/adapters-updated') },
  })

  // ── Codely（Unity 团结引擎）──
  // ✅ **目录 + 推理都已接通**（2026-10-20）：推理走 HTTP 自签直连
  //    （`codely-sign.ts`，与官方 npm 包源码逐字节对拍通过），**不需要任何客户端**。
  //    目录侧 `GET /api/model-status`（Bearer）实测 200、8 个模型组，同样无需签名。
  //    ⚠️ 适配器**有账号池** ⇒ 推理初始选号与失败换号都走
  //    `pool.getAvailableAccount`（手动顺序 + 跳过限流中账号），下面的
  //    `credentialProvider` 只是池缺席时的兜底（测试桩路径）。
  const codelyAdapter = registerCodelyLlm(ctx, {
    // ⚠️ 门控 + 黑名单都走账号池（共享目录骨架 `createModelCatalog` 读它）：
    //    没有已登录的 Codely 账号 ⇒ `listModels` 如实返回空目录。
    accountPool: pool,
    // ⚠️ 兜底凭据源：按账号池里第一个启用账号的 ref 取（与 officeace / gemini
    //    同款）。凭据按 `credentialRef` 索引存于 DSH 凭据库，多账号才不会共用一份。
    //    读不到（未登录 / 解析失败）一律 `undefined` ⇒ 目录回退兜底表，不抛错。
    //    ⚠️ 生产路径（推理）走的是适配器内的池选号，这里只服务「无池」场景。
    credentialProvider: async () => {
      const entries = pool.listAccountsByProvider(CODERLY.id)
      const first = entries.find((entry) => entry.enabled !== false) ?? entries[0]
      if (first === undefined) return undefined
      return readCodelyCredential(credentialRef(first.credentialRef), ctx.credentials as never)
    },
    onCatalogLoaded: () => { ctx.emit('llm/adapters-updated') },
    // 图片字节桥接：上游**确实收图**（2026-10-20 实测 `codely-basic` 认得出 1×1 PNG
    // 的颜色）。接上 `readImage` 后带图请求走 `image_url` parts；不接则明确报
    // `UNSUPPORTED_CONTENT`（不静默丢图）。
    readImage: makeReadImage(ctx),
  })
  // 冷启动也广播一次：首次目录在注册后异步就绪，不补这一发就只能等用户重启。
  ctx.emit('llm/adapters-updated')

  /**
   * Codely 的续期实例（2026-10-22 A6 接线）。
   *
   * ⚠️⚠️ **三个必选依赖都必须传**，少一个都是静默失效：
   * - `credentials`：不传 ⇒ `refreshAccountCredential` 第一行就 `return`（续期一次都不发）；
   * - `writebackExpiry`：不传 ⇒ 池里 `expiresAt` 不回写，界面「有效期」停在旧值
   *   （officeace 记过同款）；
   * - `fetcher`：传真实 `fetch` 即可（默认值就是），故省略。
   *
   * ⚠️ `writebackExpiry` 必须走 `pool.updateAccount`（与各家同形）—— 直接写
   *   `credentialRef` 对应的凭据不行：那份凭据已在 `refreshAccountCredential`
   *   里写回过，这里只补「池条目的有效期字段」。
   */
  const codelyAuth = new CodelyAuth(ctx, {
    credentials: ctx.credentials as never,
    writebackExpiry: async (accountId, expiresAtMs) => {
      await pool.updateAccount(accountId, {
        // ⚠️ `ProviderAccountEntry.expiresAt` 是**毫秒数值**（`number`），不是 ISO 字符串
        //    —— 写成 `toISOString()` 会直接编译失败（TS2345）。
        ...expiresAtMs === undefined ? {} : { expiresAt: expiresAtMs },
      })
    },
  })

  // ===== OpenCode Zen（账号槽 + 匿名槽平权混合池）=====
  //
  // 形态与前面所有 provider 相同：进程内 LlmAdapter 直发远端，无子进程、无端口。
  // 两处独有语义：
  // 1. **身份 = 槽**：账号槽（手动粘贴的 API key，可各配代理）+ 匿名槽
  //    （凭证就是字面量 `public`，永远本机出口）。免费模型下全槽**平权**轮换，
  //    收费模型只走账号槽（匿名凭证只被服务端认作免费通道）。
  // 2. **每账号可配代理**：NAT 后的多台 PC 共享一个出口 IP，而 Zen 的匿名通道
  //    按出口 IP 限流 ⇒ 要真正分开只能给各账号各配一条出口（`opencode-proxy.ts`）。
  //
  // ⚠️ 指纹派生的**唯一作用是防关联**（opencode 协议层没有机器指纹），
  // 不参与配额计算 —— 换配额桶只能靠换 key 或换代理。
  // ⚠️ 版本探测**不能**在 apply 里 await（apply 是同步函数）：那会让插件启动
  // 阻塞最多 2 秒。改为**懒加载**：首个请求要发时才探测并缓存，探测失败直接
  // 用 `OPENCODE.defaultUserAgent`（UA 只是伪装维度，服务端未校验真实性）。
  const opencodeUA = lazyOpencodeUserAgent()
  const opencodeAdapter = registerOpencodeLlm(ctx, {
    identitySlots: async () => listIdentitySlots(
      await Promise.all(pool.listAccountsByProvider(OPENCODE.id).map(async (entry) => {
        const resolved = await ctx.credentials
          .resolve(credentialRef(entry.credentialRef))
          .catch(() => undefined)
        let parsed: { api_key?: string } = {}
        if (resolved !== undefined) {
          try {
            parsed = JSON.parse(resolved.value) as typeof parsed
          } catch {
            // 凭据损坏：回退到匿名凭证，让用户看到「凭据未配置」而不是整条崩掉
          }
        }
        const apiKey = parsed.api_key ?? OPENCODE.anonymousKey
        // ⚠️⚠️ **指纹代次必须以账号池为权威重算**（本任务最容易漏的一步）：
        // 「指纹」按钮只把 generation 写进账号条目
        // （`updateOpencodeFingerprintGeneration`），凭据里的 `fingerprint`
        // 仍是添加账号时的旧值。若直接透传凭据里的 fingerprint，代次涨了而
        // project id **纹丝不动** —— 用户点了「指纹」却什么都没换，且**不报错**，
        // 是最难排查的一类静默失效。
        //
        // ⚠️ **派生收敛在 `poolEntrySnapshot`（唯一实现）**：探测路径（账号卡片
        // 「重测」）也要造同一个投影，两处各写一份就会分叉 —— 而分叉的那一侧
        // 恰好没有用例挡（identity 选错只是让多个匿名通道指纹相同，**不报错**）。
        // 池字段是权威（`opencodeProxyFor` / `opencodeFingerprintGenerationFor`）。
        return poolEntrySnapshot({
          id: entry.id,
          apiKey,
          enabled: entry.enabled,
          proxy: pool.opencodeProxyFor(entry.id),
          generation: pool.opencodeFingerprintGenerationFor(entry.id),
        })
      })),
      // 取值一次即可：`listIdentitySlots` 要的是字符串，不是惰性函数。
      // 首次调用时可能还是产品默认值（探测在后台跑），后续请求才用真机版本 ——
      // 宁可前几次 UA 用兜底值，也不让插件启动阻塞在 2 秒的子进程上。
      opencodeUA(),
    ),
    // ⚠️⚠️ **必须有超时**（真机事故 2026-10-02）：桌面版到 opencode.ai 的
    // fetch 可能**永不 settle**（与同源的 remote.session 故障都是宿主网络问题）。
    // 没有超时 → `loadOpencodeCatalog` 的 try/catch 永远走不到 →
    // `listModels` 永不返回 → **模型列表与徽标同时空白**（用户报障）。
    // 有超时则超时后回退兜底表，UI 立刻可用（只是暂时看不到付费模型）。
    fetchRemoteCatalog: (slot, signal) => fetch(`${OPENCODE.baseUrl}${OPENCODE.modelsPath}`, {
      headers: { authorization: `Bearer ${slot.apiKey}` },
      // 组合两个信号：调用方给的（取消）+ 自己的超时（防挂死）。
      signal: signal === undefined
        ? AbortSignal.timeout(OPENCODE_CATALOG_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(OPENCODE_CATALOG_TIMEOUT_MS)]),
    }),
    // ⚠️⚠️ **2026-10-23 迁移：黑名单与「关闭供应商」已由共享骨架从账号池读走**
    //
    // 本家此前**手写** `listModels`，故需要分别传 `disabledModels` / `providerClosed`
    // 两个回调（IKP8OF 那次就是靠这两行兜住的）。用户定稿「实体 provider 一律走
    // 共享骨架」后，那两个字段**已删除** —— 现在唯一入口是本行传进去的池。
    // ⚠️ **不要把它们加回来**：那会重现「同一语义两套判据」（本仓库红线），
    // 并掩盖池没接上这类缺陷。
    accountPool: pool,
    markLimited: async (slotId, modelId, resetAtMs) => {
      // 匿名条目同样落盘：它是池里的一条普通条目，限额标记在面板可见、
      // 可用「重测/清除」恢复（早期把匿名槽当进程内状态，重启即丢）。
      await pool.updateModelRateLimit(slotId, modelId, resetAtMs)
    },
    warn: (message) => ctx.logger.warn(`[codearts-auth] ${message}`),
    // ⚠️ 图片字节桥接：Zen 有多个免费模型实测支持图片输入（big-pickle /
    // space-bunny-free / mimo-v2.6 / mimo-v2.5，2026-10-02 真机验证），
    // 模态由 `opencode-capability.ts` 按远端 models.dev 播报。
    // ⚠️ 不接 `readImageRequest`（缩放桥接）：Zen 免费通道对图片体积的
    // 限制**未实测**，不凭猜测加一层压缩（Qoder/Raccoon 是实测撞到体积
    // 限制才接的）。先发原图，撞到限制再按实测加。
    readImage: makeReadImage(ctx),
  })
  // 保证至少有一条匿名通道（零账号也能用免费模型）。
  //
  // ⚠️ **不 await**：`apply()` 是同步的（不能 await），而这里是异步 IO。
  // 走 fire-and-forget —— 它只是「补一条默认条目」，失败最坏结果是用户
  // 手动点「+ 添加匿名通道」，而 `listIdentitySlots` 每次请求都实时读池，
  // 补完立即生效，不需要等它。
  //
  // ⚠️ **本 fork 的闸门**：`opencode` 不在 `ALLOWED_CHANNELS` 里。这段是
  //    **写盘副作用**（`pool.addAccount` + `ctx.credentials.set`），不是「注册」，
  //    所以早先挂在注册链上的闸门管不到它 —— 实测 `state.json` 里留下过
  //    `opencode-anon-49f258`、`.credentials.yaml` 里留下过两个
  //    `OPENCODE_ANON_*` ref（用户 2026-10-27 审查第①项）。
  //    ⇒ 对一个已关闭的渠道建匿名通道是纯粹的垃圾数据，闸门放在调用点。
  if (isChannelAllowed(OPENCODE.id)) {
    void ensureDefaultAnonymousSlot(
      (entry) => pool.addAccount(entry),
      (refName, value) => ctx.credentials.set(credentialRef(refName), value),
      () => pool.listAccountsByProvider(OPENCODE.id),
      // ⚠️ 判据是「池里有没有匿名条目」而不是「有没有账号」：用户若主动
      // 删光了匿名通道，那是明确选择，不该每次启动又塞回来（删除会像失灵）。
      () => pool.listAccountsByProvider(OPENCODE.id).some((e) => e.id.startsWith(`${OPENCODE.id}-anon-`)),
    ).then((id) => {
      if (id !== '') ctx.logger.info(`[codearts-auth] 已为 OpenCode 创建默认匿名通道：${id}`)
    }).catch((error: unknown) => {
      ctx.logger.warn(`[codearts-auth] 创建默认 OpenCode 匿名通道失败：${String(error)}`)
    })
  }

  // models.dev 本地缓存：启动预热 + **定期刷新**（用户 2026-10-17）。
  //
  // ⚠️⚠️ 三条硬约定（第一条是 2026-10-02 的真机事故）：
  // 1. 渲染路径上**只读同步缓存**，永不 await 网络 —— 我最初在 `listModels`
  //    里 await 这个拉取，而它 5 MB / 慢则 1.4s、宿主网络异常时**永不返回**，
  //    于是模型选择器一直空白（用户报障「一直卡着」）。
  // 2. 拉取完成要**广播目录变更**：能力表是能力判定的来源，DSH 已经用
  //    「纯文本」渲染过一帧，不广播它不会重算（免费模型会一直显示不支持图片）。
  // 3. **全仓唯一直读点**是 `src/models-dev-cache.ts`：opencode 的能力表与
  //    cline 的目录补全都只读它那份磁盘缓存，不再各自直连（此前两处各一套
  //    直连 + TTL + ETag，既重复又让 5 MB 的请求在插件里发生两次）。
  //
  // 首次运行磁盘没缓存时，本次刷新可能晚于首帧几十秒；那段时间能力按纯文本、
  // 目录按本地兜底表保守处理（见各模块的降级注释）。
  primeModelsDev()
  // ⚠️ 走**唯一**的广播实现（`src/catalog-broadcast.ts`）：能力表是能力判定的
  // 来源，它一变就必须让客户端重读目录 —— 与十个适配器的「目录落地」同一语义，
  // 不该各写一份 emit（审计指出此处曾是内联实现，且 `ctx.logger.warn` 缺两级
  // 可选链：logger 缺席时会抛、仅被 catch 吞）。
  //
  // ⚠️ 归一缓存（`opencode-capability.ts` 的 `normalized`）必须在刷新后作废，
  // 否则它会继续用旧的归一结果 —— 那是「改了没用，重启才好」的形态。
  refreshModelsDev(() => { broadcastCatalogChanged(ctx) }, {
    onUpdated: () => { invalidateOpencodeCapabilities() },
    warn: (message) => ctx.logger?.warn?.(message),
  })
  // ⚠️⚠️ **定期刷新**（用户要求「定期读取 models.dev」）：改前只有启动时那一次，
  //   上游新增模型后**必须重启进程**才看得见（`TtlCache` 模块头记的就是这条
  //   缺陷的同型）。周期取 TTL 的一半（3 小时）—— 比 TTL 短才能保证「最坏
  //   情况下也只落后半个 TTL」，比 TTL 长则会让每次刷新都撞在 TTL 判据上而
  //   **真的发出请求**前就返回（那样等于没有周期刷新）。
  const modelsDevTimer = setInterval(() => {
    refreshModelsDev(() => { broadcastCatalogChanged(ctx) }, {
      onUpdated: () => { invalidateOpencodeCapabilities() },
      warn: (message) => ctx.logger?.warn?.(message),
    })
  }, Math.floor(MODELS_DEV_TTL_MS / 2))
  ;(modelsDevTimer as unknown as { unref?: () => void }).unref?.()
  // ⚠️ 回收：定时器必须随插件卸载而停，否则进程退出会被它挂住
  //   （与上面 `closeAllProxyDispatchers` 的回收并列，同款约定）。
  ctx.effect(() => () => { clearInterval(modelsDevTimer) })
  // ⚠️ 这里**不再**调 `registerOpencodeRpc`：opencode 的端点已并入
  // `registerJetHubRpc` 内部的 handleMethod（见 `opencode-rpc.ts` 模块头）。
  // 代理 dispatcher 是常驻连接池：插件卸载必须回收，否则进程退出会挂住。
  // ⚠️ 用仓库既有的 `ctx.effect(() => () => …)` 回收模式；cordis 的 Events
  // 里**没有** `dispose` 事件（`ctx.on('dispose', …)` 直接类型报错）。
  ctx.effect(() => () => { void closeAllProxyDispatchers() })

  // ===== 大肥鱼饭碗 RPC 注册 =====
  // 大肥鱼饭碗「自动」：一个 `auto` 模型名用整池，按「积分最快作废」跨 provider 选型
  // （见 `auto-adapter.ts` 模块头）。注册放在全部 provider 适配器之后：它经
  // ctx.llm 公开路径委托目标适配器，目录/凭据此时均已就绪。
  //
  // ⚠️ 位置在 `modelAdapters` 表**之前**：那张表要收它的实例（见下面的
  //    `'jet-hub-auto'` 键），而 `usage.badge` 对 `jet-hub-auto` 的改写依赖它。
  // ⚠️ 上游 `ba10f4f` 重写 aggregate 时把这条接线一并删掉了 ⇒ 旧 auto 的徽标
  //    彻底消失（用户报障 2026-10-08「也没胶囊了？」）。这里补回来。
/**
 * **静态回退积分表**（无 deps 版工厂）—— 供 {@link fetchBalanceReading} 在
 * runtime 缺席时兜底。模块级常量：工厂是纯函数，表在进程内不变。
 *
 * ⚠️ 与端点侧（`jet-hub-rpc.ts`）/runtime 侧（`creditsTable`）**同源同构**
 *（同一个 `createProviderCredits`），差异只在 deps。
 */
const FALLBACK_CREDITS_TABLE = createProviderCredits()

/**
 * 共享缓存的**取数原语**（从 `credits.balances` 的查表分派里抽出的那一半）。
 *
 * ## ⚠️ 为什么必须与 `credits.balances` 用同一个函数（规格 §11-1 的核实结论）
 *
 * 两条路径（面板端点 / 聚合折算）取的是**同一个数**：只有共用同一份取数实现，
 * 「面板显示的余额」与「折算据此排序的余额」才不可能分叉。若各写一份，两边
 * 对同一份报文可能得出不同的 `error` / `extra` 口径（本仓库首条红线）。
 *
 * ⚠️ 取数**不含 self-heal**：续期留在 `credits.balances` / `credits.claimAll` 的
 * **端点入口**（规格 §5.7.1 末行）—— 折算路径触发填充时不该把续期开销带进发消息路径。
 * ⚠️ opencode / qoder 族 / officeace 的**特例短路仍在端点里**（它们不走本原语）：
 * 本函数只处理「查表分派」那一段（`creditsOf` + `fetchBalance(Detailed)`）。
 *
 * @returns 解析出的 `CreditBalance`（失败时抛错 ⇒ 缓存记成 `error` 读数）。
 */
async function fetchBalanceReading(
  pool: AccountPool,
  provider: string,
  entry: BalanceCacheEntry,
): Promise<unknown> {
  const runtime = runtimeOf(provider)
  // ⚠️⚠️ **runtime 缺席时回退到静态积分表**（真实缺陷，2026-10-19 实测打穿）：
  //    codely 是全仓首例「balance:true + 无 runtime」的渠道（channel:false、
  //    无 auth 服务 ⇒ `src/index.ts` 的注册循环里没有它 ⇒ 没有 ProviderRuntime）。
  //    本原语原先只认 runtime ⇒ 对 codely 恒抛 `unsupported provider: codely` ⇒
  //    缓存记成失败读数并**兼顶旧值 15 分钟**，面板积分行显示
  //    「本次查询失败，显示的是 … 的数据（unsupported provider: codely）」——
  //    而端点侧的表里明明有它（首次成功的那次读数正是端点表查出来的）。
  //
  //    回退表用**无 deps** 的工厂：codely 的原语是纯自由函数，不依赖任何
  //    auth 实例。⚠️ 有 runtime 的渠道**永远先命中 runtime**（含 loomy /
  //    raccoon / zcode 的实例 fetchImpl 路径），本回退只在「该声明了余额能力
  //    却没注册 runtime」的渠道上生效 —— 那正是本函数原本完全无法服务的形态。
  const impl = runtime?.credits ?? creditsOf(FALLBACK_CREDITS_TABLE, provider)
  if (impl === undefined) throw new Error(`unsupported provider: ${provider}`)
  if (entry.credential === undefined) throw new Error('凭据未提供')
  // ⚠️ `ProviderCallContext` 的三个字段与 `jet-hub-rpc.ts` 里那份**同形**
  //（那里是端点闭包内的注册实例，这里是装配层的实例；实现侧只需一个形状）。
  // ⚠️ 必须与端点那份**指向同一个池**，否则折算拿到的账号集合与面板看到的不一致。
  // ⚠️ `accountId` **必须带上**（Gitee issue IKLTZ2）：Gemini 折算路径要按账号
  // 取出口代理；漏了它 ⇒ 这条路径恒直连，症状是「面板能刷新、聚合折算却失败」。
  const callContext = {
    resolveCredential: (refName: string) => ctx.credentials.resolve(credentialRef(refName)),
    warn: (message: string) => ctx.logger?.warn?.(message),
    accountPool: pool,
    accountId: entry.id,
  }
  // ⚠️ `fetchBalanceDetailed` 优先（它带 `error` / `extra`，是既有端点的口径）。
  if (impl.fetchBalanceDetailed !== undefined) {
    const detailed = await impl.fetchBalanceDetailed(entry.credential, callContext)
    if (detailed.balance === null) throw new Error(detailed.error ?? '余额查询失败')
    return detailed.balance
  }
  if (impl.fetchBalance === undefined) throw new Error(`unsupported provider: ${provider}`)
  const balance = await impl.fetchBalance(entry.credential, callContext)
  if (balance === null) throw new Error('余额查询失败')
  return balance
}

  // ⚠️ 本 fork 已移除聚合路线（`aggregate` provider），但**共享临期探针保留**：
  //    `auto` 仍靠它折算「谁最快作废」。探针本身与聚合无关，只是历史上与聚合
  //    共用同一个实例（避免同一渠道被折算两次、缓存要清两遍）。
  // ⚠️ 定义必须在 `modelAdapters` 表与 `registerJetHubRpc` 之前（它们要用）。
  const sharedExpiryProbe = createExpiryProbe(pool, async (provider) => {
    const models = await ctx.llm.listModels(provider)
    return models[0]?.id
  }, {
    /**
     * ★ zcode 的**按模型额度**判定需要全部目录模型 id（2026-10-12）。
     *
     * 上游 `capabilities` 是**小写**（`glm-5.3`），而池过滤的键是目录形态的
     * **大写**（`GLM-5.3`）⇒ 必须用这张目录去比对，否则标记写进去永远不命中
     * （静默失效，见 `zcode-entitlements.ts` 的 `exhaustedModelsOf`）。
     *
     * ⚠️ **只对 zcode 求值**：其余 6 家不调这个函数（探针里是惰性的），
     *    故它们每轮**零额外目录读取**。这里仍加 `provider === ZCODE.id` 判断，
     *    是为了让「谁需要它」在装配层一眼可见。
     *
     * ⚠️⚠️ **本段接线此前零测试守卫**（2026-10-12 对抗审计实测）：
     *    把它整段删掉，4 个相关 spec **158 条全绿**，而生产行为会退化 ——
     *    判定范围只剩 `probeModel` 一个模型 ⇒ 「两个专属桶都烧光」时
     *    **第二个模型不被标记**，直选它仍会拿到已尽的账号。
     *    ⇒ 违反的是**需求 (C) 的规模**（判据对，范围错）。
     *    `tests/unit/zcode-model-entitlements.spec.ts` 的
     *    「真实装配」段现在驱动**这一段真代码**（从 `index.ts` 里取值，
     *    不手写 `[...CATALOG]` 桩）—— 删掉本段即红。
     */
    catalogIdsOf: async (provider) => {
      if (provider !== ZCODE.id) return []
      const models = await ctx.llm.listModels(provider)
      return models.map((model) => model.id)
    },
    /**
     * ★★ **共享余额读数**（2026-10-15，规格 §5.7）。
     *
     * ## 用户原话（本模块存在的理由）
     *
     * 「为什么不能更新账号积分用共享缓存，取号逻辑只是在调用缓存的时候取舍的问题，
     * 不影响刷新账号积分缓存呢，账号积分缓存是更底层基础设置，计算怎么取号是
     * 基础设施上的使用逻辑」
     *
     * ⇒ 这里注入的是**同一个** `balanceCache` 实例（`credits.balances` 端点用的是
     * 它）—— 于是 buddy 系四家的折算**吃同一份读数**，而不是各自再打一次上游。
     * 「只给可用账号」这一取舍由 `createExpiryProbe` 自己的取号逻辑决定
     *（它本来就只遍历可用账号），与缓存无关。
     *
     * ⚠️ 返回 `undefined` ⇒ **本次没有共享读数** ⇒ 实现方回落到自己发请求
     * （`fetchBalanceWithCache`，见 `aggregate-expiry.ts:275` 的契约）：
     * 折算的**可用性**不得依赖本缓存（否则缓存不可用会静默变成「该渠道折算恒 UNUSABLE」）。
     * ⇒ 而返回 **`null`** 是「结论：这个账号现在不可用」（`sharedPackageExpiry`
     * 对 `null` 判 `UNUSABLE`，且**不**回落重查）—— 下面那条正是这一格。
     */
    balanceOf: async (provider, accountId, credential) => {
      const reading = await balanceCache.readOne(provider, accountId, { credential })
      // ★★ **陈旧读数不得参与折算**（2026-10-18）。
      //
      // 读路径改成 stale-while-revalidate 后，缓存陈旧时折算会拿到**旧值**，
      // 而 `stale` 字段原先只在 `readStale` 里判（`balance-cache.ts` 的注释记着
      // 那个限制）⇒ 折算会**静默地长期用 10 分钟前的数字排序**。
      //
      // ⚠️⚠️ **必须返回 `null` 而不是 `undefined`**（实测确证，2026-10-18）：
      //   契约（`aggregate-expiry.ts:275`）与实现（`fetchBalanceWithCache`）都规定
      //   `undefined` = 「**本次没有共享读数**⇒ 回落到自己发请求」，`null` 才是
      //   「结论：不可用」。实测（mock `fetchCreditBalance` 成功）：
      //     - 返回 `undefined` ⇒ fallback **被调用 1 次**，折算返回**上游的值**（≠ UNUSABLE）
      //     - 返回 `null`      ⇒ fallback **0 次**，折算返回 `-1`（UNUSABLE）
      //   ⇒ 写 `undefined` 会得到「陈旧账号每次折算**多打一次上游请求**」，
      //     恰恰是本条要消灭的行为（且与「读路径一个请求都不发」相悖）。
      //
      // ⚠️ 与 officeace 分支的既有约定同构（`aggregate-expiry.ts:1141`：
      // 「`summary.stale === true` ⇒ 判 `UNUSABLE`」）。同一次改动在别处新增了
      // 这条、而面板出口把两天前的快照当实时余额显示，被审计记为
      // 「**同一份数据两层结论相反**」（`jet-hub-rpc.ts:5462`）——
      // 本行就是避免复发的那一腿。
      //
      // ⚠️ **有意的行为代价（如实登记）**：折算可能因陈旧读数而少一个候选渠道，
      // 用户表现为**聚合轮换里某个渠道暂时不出现**。这比「用 10 分钟前的数字
      // 排序」安全，且与 officeace 既有行为一致（用户 2026-10-18 明确接受）。
      if (reading.stale === true) return null
      return reading.error === undefined ? reading.value : undefined
    },
  })
  // ⚠️ 赋给上面的可变引用 ⇒ 账号入库时清空折算缓存（见那里的注释）。
  sharedExpiryProbeRef = sharedExpiryProbe

  const autoAdapter = registerAutoLlm(ctx, {
    accountPool: pool,
    // ⚠️ **与 aggregate 共用同一个探针**（真实缺陷，对抗审计实测证伪）：
    //    不传时 `AutoAdapter` 会**自建一份**，于是有两份独立缓存 ⇒
    //    ① 同一渠道被折算两次（白打两次上游余额接口）；
    //    ② 缓存失效要清两次，漏一次就让「刚登录的账号最长 60 秒对路由不可见」。
    expiryProbe: sharedExpiryProbe,
  })
  // provider → 适配器实例：大肥鱼饭碗「显示列表」需要 `listAllModels()`（不受用户
  // 黑名单影响的全量目录，带最终展示名/倍率）。DSH 的 `ctx.llm` 只保证
  // `listModels`，不透传自定义方法，故这里显式把实例传下去。
  //
  // ⚠️⚠️ **必须走 `withDeadModelPruning`，不能直接用 `registerXxxLlm` 的返回值**
  // （致命缺陷，2026-10-06 复审 !66 实测）：那些函数返回的是 `new XxxAdapter(...)`
  // —— **原始实例**，而 `registerAdapterIdempotent` 只把**代理**注册进了 `ctx.llm`。
  // 于是 `jet-hub-rpc` 的 `model.list` 先 `await llm.listModels()`（走代理，已剔除），
  // 紧接着又用本表的 `listAllModels()` **覆盖**成全量目录（走原始，**未剔除**）⇒
  // 已失效模型被加回设置页，PR 想修的「用户仍看到下架模型」原问题**完全没修到**。
  //
  // 这里复用与注册**同一个**包装函数，确保两条路径的可见性一致。
  // ⚠️ `codearts` 不在 `modelAdapters` 的常规形态里，但它同样需要该包装。
  //
  // ⚠️ 包装失败**不阻断启动**：回退到原始实例即可（它只是显示层的收敛）。
  const pruned = <T extends object>(
    provider: string,
    adapter: T,
    options?: { enabled?: boolean },
  ): T => {
    try {
      return withDeadModelPruning([provider], adapter, options)
    } catch (error) {
      ctx.logger.warn(`[jet-hub] ${provider} 的失效模型剔除包装失败，使用原适配器: ${String(error)}`)
      return adapter
    }
  }
  // ★ **本 fork 的渠道白名单**：先建全量表 `modelAdaptersAll`，再按白名单过滤成
  //   `modelAdapters`。不直接删表里的条目 —— 22 个 adapter 实例在 apply 里都已被
  //   创建（`registerAdapterIdempotent` 只是不注册路由），表里留着它们便于
  //   `usage.badge` / `listAllModels` 等路径拿到真对象；「可见与否」由白名单决定。
  const modelAdaptersAll: Record<string, { listAllModels(): readonly { id: string; name: string }[] }> = {
    // `codearts` 是 registerCodeArtsLlm 返回的**适配器实例**（与 CodeArtsAuth
    // 服务实例 `service` 不同名，故这里可以简写）。
    codearts: pruned(CODEARTS_PROVIDER, codearts),
    buddy: pruned('buddy', buddyAdapter),
    workbuddy: pruned('workbuddy', workbuddyAdapter),
    lobsterai: pruned(LOBSTERAI.id, lobsteraiAdapter),
    qoder: pruned(QODER.id, qoderAdapter),
    qodercn: pruned(QODER_CN.id, qoderCnAdapter),
    trae: pruned(TRAE.id, traeAdapter),
    cline: pruned(CLINE.id, clineAdapter),
    loomy: pruned(LOOMY.id, loomyAdapter),
    raccoon: pruned(RACCOON.id, raccoonAdapter),
    minimax: pruned(MINIMAX.id, minimaxAdapter),
    minimaxintl: pruned(MINIMAX_INTL.id, minimaxIntlAdapter),
    autoclaw: pruned(AUTOCLAW.id, autoclawAdapter),
    // ⚠️ 国际版与国内版**同一套实现的两个实例**，但 provider id 不同 ⇒
    //    必须各自一条（与 minimaxintl 同款）。键是 provider id `autoclawintl`
    //    （全小写），值是变量 `autoclawIntlAdapter`（驼峰）。
    autoclawintl: pruned(AUTOCLAW_INTL.id, autoclawIntlAdapter),
    accio: pruned(ACCIO.id, accioAdapter),
    gemini: pruned(GEMINI.id, geminiAdapter),
    zcode: pruned(ZCODE.id, zcodeAdapter),
    opencode: pruned(OPENCODE.id, opencodeAdapter),
    // ⚠️ **本 fork 独有**（modelscope，2026-10-16）。必须进这张表：
    //    `provider.status` 的「已关闭」判据是 `total > 0 && disabled === total`，
    //    它读的是 `listAllModels()` 那份**不套黑名单**的全量目录。表里缺它 ⇒
    //    退化到 `llm.listModels`（已按黑名单过滤）⇒ 「关闭整个 provider」时
    //    漏写黑名单 ⇒ 出现「provider 显示已关闭、模型却仍可选用」的矛盾态。
    modelscope: pruned(MODELSCOPE.id, modelscopeAdapter),
    // OfficeAce（华为 MaaS 云端直连）：目录静态 + 平台侧可用性，同其余渠道。
    officeace: pruned(OFFICEACE.id, officeAceAdapter),
    // AStudio（上游 MAAS 云端直连）：目录来自 model-manager 远端 + 兜底表，同其余渠道。
    astudio: pruned(ASTUDIO.id, astudioAdapter),
    // ⚠️ **codely 进本表但 `channel` 保持 `false`**（2026-10-20 修订，用户报障
    //    「面板模型 0」后的复核结论）：本表键守卫（`refresh-targets-derived.spec.ts`
    //    ⑦）允许 `EXTRA_KEYS` 显式例外（`aggregate` 是先例），而本渠道**必须**进表
    //    —— 与 modelscope 那条同因：`provider.status` 的「模型数 / 已关闭」判据读
    //    本表的 `listAllModels()`；「关闭整个 provider」也要靠它拿全量目录写黑名单。
    //    表里缺它 ⇒ 面板恒「模型 0」，且**模型选择器里的 8 个模型关不掉**（矛盾态）。
    //    进表 ≠ 假桩：适配器是真实的（目录来自实测 200 的 `/api/model-status`，
    //    `stream()` 显式报「推理通道尚未接通」）——守卫禁的是「用假实现应付判据」，
    //    不是「有目录没推理」这个真实过渡态本身。
    //    ① 键守卫侧：已在用例 ⑦ 的 `EXTRA_KEYS` 登记理由（channel:false 例外）；
    //    ② 推理侧：`channel: true` 会被三张派生守卫当成「应有 auth / 应进聚合
    //       目录 / 应可续期」，在推理与续期落地前**仍然不翻**（那是真要假桩的地方）。
    codely: pruned(CODERLY.id, codelyAdapter),
    // ⚠️ 聚合 provider 也必须进这张表（设计文档 §5.2 的必改点）：`jet-hub-rpc.ts` 的
    // `fullCatalogIds` **优先**用本表的 `listAllModels()`（不套黑名单的全量目录），
    // 缺失时才退化到 `llm.listModels(provider)` —— 后者已被适配器按黑名单过滤。
    // 于是「关闭整个聚合 provider」时只拿到**未被关闭的** id ⇒ 已关闭的模型漏写黑名单，
    // 而 `provider.status` 的判据是 `closed = total > 0 && disabled === total`
    // ⇒ 出现「provider 显示已关闭、模型却仍可选用」的矛盾态。
    // `pruned(...)` 会包上失效模型剔除；聚合已提供**同步** `listAllModels()`，满足契约。
    // ⚠️ 但聚合必须传 `enabled: false`（**完全不参与**该机制：不记录、**也不过滤**）
    //    —— 真实缺陷（全分支终审 C2 + 审计轮次二补修的残留面）。本机制是为
    //    「**编译期兜底快照**跟不上上游下架」设计的，而聚合层的目录是**动态推导**的
    //    （上游下架后下次推导自然消失）⇒ 既不需要记录，也不该被过滤。
    //    ① **记录**的危害：外层包装观察到的是 `aggregate` + **虚拟键**（实测），于是
    //       「某一个渠道没有该 realId」被记成「**整个规范模型**失效」，而它在其余渠道
    //       上完全可用；且恢复入口 `model.clearDead` 的 UI 在设置页 provider 面板里，
    //       而客户端 `PROVIDERS` **没有 `aggregate`** ⇒ **没有任何 UI 能恢复**。
    //    ② **过滤**的危害（补修的那半）：初版只跳过记录、仍保留过滤 ⇒ 若表里**已有**
    //       旧版本写下的 `aggregate` 记录（C2 修复前跑过一次就会有），虚拟模型**仍被
    //       隐藏**，且同样无 UI 可恢复 —— 实测探针确认（预置 `aggregate/m1` 后
    //       `listModels` 只返回 `['auto','m2']`）。
    //    ⇒ 传 `enabled: false` 让本函数**直接返回原适配器**，历史遗留记录被忽略。
    // ⚠️ 旧 auto 也必须进这张表：`jet-hub-rpc.ts` 的 `usage.badge` 经它取
    //    「实际转发历史 / 预测 / 倍率」（见 `ModelCatalogSource.autoState`）。
    //    ⚠️ **不能**给 `registerJetHubRpc` 加第 17 个位置参数 —— 那条派生式不变量
    //    「客户端 PROVIDERS 条数 + 1 == 形参个数」会立刻变红（实测 10 条接线断言
    //    同时失败），而它正是为了防「位置错位 = 拿 A 的实例当 B 用」。
    //    ⚠️ 同样传 `enabled: false`：auto 是**动态**的单模型（真实目标由选型决定），
    //    「编译期兜底快照跟不上上游下架」那套记录/过滤机制对它没有意义。
    'jet-hub-auto': pruned(AUTO_PROVIDER, autoAdapter, { enabled: false }),
  }

  // ★ 本 fork：按白名单过滤（`jet-hub-auto` 是 `channel: false`，恒保留；
  //   `aggregate` 已在本 fork 移除）。
  //   ⚠️ 必须在 `modelAdapters` 这个**名字**上过滤，下游（catalog 刷新器、
  //   `registerJetHubRpc`、`installWebNative`）都按这个名字取表。
  const modelAdapters: typeof modelAdaptersAll = Object.fromEntries(
    Object.entries(modelAdaptersAll).filter(([id]) => isChannelAllowed(id)),
  )
  const droppedAdapters = Object.keys(modelAdaptersAll).filter((id) => !isChannelAllowed(id))
  if (droppedAdapters.length > 0) {
    ctx.logger?.info?.(
      `[jet-hub] 渠道白名单生效，已跳过 ${droppedAdapters.length} 个渠道的目录注册：`
      + droppedAdapters.join(', '),
    )
  }

  /**
   * ★ **模型目录的后台刷新器**（用户 2026-10-18 的要求）。
   *
   * 「各个模型的模型列表缓存也要带定时更新，20 分钟更新一次，如果不更新随高峰低谷
   * 变化的积分消耗倍率是更新不到实际的倍率」
   *
   * ## ⚠️ 为什么必须建在 `modelAdapters` **之后**（位置不变式）
   *
   * 它要读那张表拿实例。早于建表 ⇒ 空表 ⇒ **目录永不刷新、且零日志**
   * （与 `wiredRefreshTargets()` 前身在 2026-10-15 踩的坑同型）。
   *
   * ## ⚠️ 为什么走 `modelAdapters` 而不是 `ctx.llm`
   *
   * `ctx.llm` 是 DSH 的公开面，**不认识** `refresh()`（那是本插件给目录契约加的可选成员）。
   * 而 `modelAdapters` 的每一项都是 `pruned()` 的 Proxy —— 它对**其余成员原样透传并绑定
   * `this`**（`src/dead-model-store.ts:748-749`），故新加的 `refresh()` 能自动透出来。
   *
   * ## ⚠️ 未实现 `refresh` 的 provider 必须跳过
   *
   * `opencode` 这类本地派生渠道（零网络）本就没有远端可拉。对它们空转会让
   * 「刷新器说跑了 9 家、实际只刷了 3 家」**完全静默**。
   */
  const catalogRefresher = createCatalogRefresher({
    listProviders: () => Object.keys(modelAdapters),
    refreshOf: (provider) => {
      const adapter = modelAdapters[provider] as { refresh?: () => Promise<void> } | undefined
      const refresh = adapter?.refresh
      // ⚠️⚠️ **`undefined` 只能表示「这家没有该成员」**（2026-10-20 修正）：
      //    刷新器据此统计「本轮几家真的参与」，**零参与即 warn**
      //    （见 `createCatalogRefresher` 的注释）。故**不要**写成
      //    `return adapter?.refresh?.()` —— 那会让「成员存在但同步返回 void」
      //    与「成员根本不存在」不可区分，统计随之失真。
      //    ⚠️ 而本仓库实测的失效形态恰恰是「成员根本不存在」：`be42b25` 给
      //    `createModelCatalog` 的 config 加了 `refresh` 回调，却**没有**把它
      //    转发成适配器实例的成员，而该提交的注释误以为 `pruned()` 的 Proxy
      //    会把它透出来（Proxy 只透传适配器**自己的**成员）。
      if (typeof refresh !== 'function') return undefined
      return Promise.resolve(refresh.call(adapter)).then(() => undefined)
    },
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
  })
  // ⚠️ 生命周期挂 `ctx.effect`，与插件一致（释放后停手）——
  //    与既有 `modelsDevTimer`、余额刷新器同款约定。
  ctx.effect(() => {
    catalogRefresher.start()
    return () => { catalogRefresher.stop() }
  })

  // 插件卸载前把签名缓存落盘：`stream()` 每次结束都 flush，但用户可能
  // 直接关掉 DSH 而上一轮的 flush 还在排队 —— 落一次盘几乎零成本，
  // 丢的却是「下一轮工具调用能不能带上签名」。
  ctx.effect(() => () => { void geminiSigStore.flush().catch(() => {}) })

  // 冷启动的**有界目录预热**（issue IKJVTF 的冷启动自愈半条）。
  //
  // 为什么必须有：首拉失败后适配器回落到**静态兜底表**，客户端把这份兜底目录
  // 缓存成 `status: 'ready'`（它只认宿主事件），而**没有任何东西会在冷却到期后
  // 再问一次** —— 只有用户主动打开设置页/切模型才可能触发下一次 `listModels`。
  // 于是「远端目录其实早已可达，只是没人再问」会一直持续到用户碰巧触发重读。
  //
  // ⚠️ **间隔必须大于 `RemoteCatalogGate` 的 30 秒失败冷却**，否则重试被闸门
  // 原样挡回、什么也不做（等于没预热）。该约束由 `catalog-prewarm.ts` 的
  // `CATALOG_PREWARM_DELAYS_MS` 与 `tests/unit/catalog-prewarm.spec.ts` 共同守着。
  //
  // ⚠️ 走 `ctx.llm.listModels` 而不是适配器私有方法：它会走完整路径
  // （账号门控 → `ensureRemoteModels` → 闸门），目录已就绪时是**零网络**的，
  // 且对 `withDeadModelPruning` 包装透明（直接拿原始实例会绕过那层收敛）。
  //
  // ⚠️ **不 await**：`apply()` 是同步函数，预热会发网络请求（与既有的
  // opencode 能力预热同款约定）。停止函数挂 `ctx.effect`，插件释放后停手。
  ctx.effect(() => startCatalogPrewarm({
    providers: Object.keys(modelAdapters),
    warm: (provider) => ctx.llm.listModels(provider),
    logger: { warn: (message) => ctx.logger?.warn?.(message) },
  }))

  // ⚠️ **命名对象**（2026-10-08 改，原为 13 个位置参数）：位置参数下改顺序/插队
  // 都会**静默错位**（症状是「某个 provider 用另一个 provider 的凭据续期」），
  // 本仓库历史上因此复发 6 次。命名对象让错位在类型层面不可能，且新增 provider
  // 只加一个键。
  //
  // ⚠️ **键是 provider id `qodercn`，值是变量 `qoderCn`** —— 两者不同名是刻意的：
  // 键必须与 `entry.provider` 同形，否则按 id 取实例会落空（`authOf(auths, id)`，
  // 见 `jet-hub-rpc.ts` 的 `JetHubAuths` 注释）。本地变量名沿用既有惯例。
  // 写成 `qoderCn:` 会编译失败（接口没有该键），这正是我们要的。
  //
  // ⚠️ **分派现状**：`account.refresh` **已**改成 `authOf(auths, entry.provider)`
  // 查表分派（Task 2 完成，见 `jet-hub-rpc.ts` 的 `account.refresh` 分支）——
  // Task 9 引入命名对象时还在的那 13 个同构 `switch (entry.provider)` case
  // （含 `requireQoderFamily` 取 Qoder 同族实例那一处）**已整体删除**。
  // 上面「键必须是 provider id」那条约定正是该查表能命中 `qodercn` 的前提。
  // ===== 积分能力表（设计文档 §3.3 / Task 3）=====
  //
  // ⚠️ **只建一份，且只挂一个消费点**：`ProviderRuntime.credits` ——
  //    给**拿不到 `auths` 形参**的跨模块消费点（Task 5 的 `aggregate-expiry.ts`、
  //    Task 8 的 `account-probe.ts`）。
  //
  // ⚠️ `credits.balances` / `credits.status` **不再读这里**（2026-10-08 设计复审 C1）：
  //    它们由 `registerJetHubEndpoints` 从**已解构的 `auths`** 现造一张等价的表。
  //    原先本处还把它当第 5 个实参传给 `registerJetHubRpc`，那既是一个纯测试接缝
  //    （生产路径上两处传的是**同一批实例**、删掉实参行为不变），又是一个
  //    可选的**位置**形参 —— 在它之前插入新形参会**静默**错位（本仓库实测复发
  //    6 次的形态）。
  //
  // ⚠️ **两处是两个独立的 `createProviderCredits` 调用**（本处 + `jet-hub-rpc.ts`），
  //    故「有人改了一处忘了另一处」在原理上仍可能。防线是**两侧各自被钉在
  //    `PROVIDER_REGISTRY` 上**，而不是「只有一份所以不可能漂移」：
  //    - 本处的表 → `provider-runtime-wiring.spec.ts` 真跑 `apply()`，
  //      断言每个有余额能力的渠道 `runtimeOf(id).credits` 都**有余额方法**；
  //    - 端点侧的表 → `credits-runtime-parity.spec.ts` 的「表里的渠道集合 ===
  //      registry 里有余额能力、且非特例的渠道」（含带 deps 的形态）。
  //    两侧同源同构，故任一侧少一家都会被点名。
  //
  // ⚠️ 三家（loomy / raccoon / zcode）的余额查询走**各自 auth 实例**上的方法
  //    （实例可能带注入的 `fetchImpl`），故必须传实例 —— 重构前 RPC 就是这么调的。
  //    其余走自由函数 + 全局 fetch。
  const creditsTable = createProviderCredits({
    loomy, raccoon, zcode,
    // ⚠️ LobsterAI 的 `clientVersion` 是签到**必填**参数且**动态**解析（带 TTL 缓存）
    //    —— 故传**惰性**解析器，不能先 await 成一个常量（那会让「缓存过期后拿到
    //    新版本」失效）。见 `ProviderCreditsDeps.lobsteraiClientVersion`。
    lobsteraiClientVersion: () => lobsterai.resolveClientVersion(),
    // ⚠️⚠️ **MiniMax 国际站的 XFF 必须在这里也接上**（真实缺陷，2026-10-17 审计打穿）。
    //
    // 本文件与 `jet-hub-rpc.ts` 是**两个独立的 `createProviderCredits` 调用**
    //（上面那段注释正是为此而写），而 `ProviderRuntime.credits` 被
    // `fetchBalanceReading`（本文件 L≈3136）消费 —— 后者是 `balanceCache` 的
    // **取数原语**：`collectCreditBalances` 命中缓存前会先走它，失败才回落到端点表。
    //
    // ⇒ 只接端点表的话，**面板第一次查国际站余额走的正是这条无 XFF 的路径**，
    //   失败后还要吃满 failureTtl（15s）才可能重试 —— 症状就是「设了 XFF，
    //   积分行仍然查询失败」。本次只改了一处，正是那份注释警告的形态。
    //
    // ⚠️ 惰性读（用户随时可能改设置），不能固化成字符串。
    minimaxXff: () => pool.minimaxXff(),
    // ⚠️ Gemini 的按账号 fetcher（Gitee issue IKLTZ2）：**折算路径**也要走代理，
    // 否则「面板能刷新、聚合候选却恒折算失败」—— 与上面 minimaxXff 同型陷阱
    // （这里也正是它第一次被引入的同一个 `createProviderCredits` 调用）。
    geminiFetchFor: geminiFetchForAccount,
    // ⚠️⚠️ **MiniMax 国际站的按账号 fetcher**（PR !145 审计 P0 修法，真实缺陷）：
    // 与上面 `geminiFetchFor` **逐格同因** —— 积分行是用户点一下就等的主路径，
    // 而 `agent.minimax.io` 按出口 IP 国别分流（大陆直连恒 307 → 中国站 → 401）。
    // 不接它 ⇒ 用户配好代理后对话能用、**积分行却仍报「余额查询失败」**，
    // 症状与 issue IKMEVG 逐字相同（PR !145 当时只接了选号器，本文件这处漏了）。
    minimaxIntlFetchFor: minimaxIntlFetchForAccount,
  })
  /**
   * **一次性奖励**能力表（Loomy 新手任务 / raccoon 登录奖励）。
   *
   * ⚠️ 与 `creditsTable` 同款：两处（本处 + `jet-hub-rpc.ts`）是两个独立调用，
   *    防线是**两侧各自被钉在 `PROVIDER_REGISTRY` 上**，而不是「只有一份」。
   */
  const onboardingTable = createProviderOnboarding({ loomy, raccoon })

  /**
   * **临期折算**能力表（供聚合 / auto 的候选排序）。
   *
   * ⚠️ 与 `creditsTable` / `onboardingTable` 的关键区别：本表是**唯一**的一份，
   *    且它的消费点**只有** `ProviderRuntime.expiry` —— 没有任何端点侧副本
   *    （那两个域各有第二份「从 `auths` 现造」的表，本域没有：它的消费者是
   *    `src/aggregate-expiry.ts`，那是个拿不到 `auths` 形参的独立模块）。
   *
   * ⚠️ 表**建在 `src/provider-expiry.ts`**（而不是内联在这里）：几十处既有用例
   *    直接构造 `createExpiryProbe` / `AggregateAdapter`、**不调 `apply()`**，
   *    它们要验折算**值**（TTL 缓存 / 取全部账号 / `clear()`）就必须让 runtime 里
   *    有**真实**实现。表若内联在此，那些用例只能各写一份自己的映射 ⇒
   *    「同一语义两套判据」（本仓库首条红线）。生产与单测**共用同一份**。
   *
   * ⚠️ **只挂「已接入临期折算」的渠道**（`expiry` 域存在即已接入）——
   *    **刻意不在此写数字、也不抄名单**：同一事实的多份抄写必然漂移（见本文件下方
   *    `probeById` 那段教训）。`WIRED_EXPIRY_PROVIDERS` 与它的一致性由
   *    `tests/unit/expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死：
   *    未接入的渠道**不该**出现在聚合候选里。返回 `UNUSABLE` 也会被剔除，
   *    但让它压根不进目录更诚实 —— 见 `aggregate-expiry.ts` 的长注释。
   *
   * ⚠️ **这里挂的是「选哪个原语」，不是原语本身**：各家的 `*Expiry` 原语
   *    （判据与量纲各异）原样保留在 `aggregate-expiry.ts`
   *    （设计文档 §3.5.3 / §3.6 的边界）。
   *
   * ⚠️ 用 `expiryOf` 而非下标（原型链键误判），与 `creditsOf` 同因。
   */
  const expiryTable = createProviderExpiry({
    // ⚠️⚠️ **MiniMax 国际站的 XFF 必须在这里也接上**（2026-10-20，与 L3858 那处
    //    `creditsTable` 的 `minimaxXff` **同因**）。
    //
    // `ProviderRuntime.credits` 与 `ProviderRuntime.expiry` 是**两个独立消费域**
    //（前者喂积分面板，后者喂聚合候选排序），两者的 xff 通道**各走各的**：
    // 只接 credits 那处的话，症状正是「面板能刷新、聚合候选却恒折算失败」
    //（本仓库在 2026-10-17 审计里已对 `creditsTable` 记录过同型缺陷）。
    //
    // ⚠️ 惰性读（用户随时可能改设置），不能固化成字符串。
    minimaxXff: () => pool.minimaxXff(),
    // ⚠️⚠️ **按账号出口也必须在这里接**（PR !145 审计 P0 修法，与上面
    //    `minimaxXff` **逐格同因**）。`credits` 与 `expiry` 是两个独立消费域，
    //    通道各走各的：只接 credits 那处 ⇒ 积分行能刷新、**聚合候选却恒折算失败**；
    //    只接 expiry 那处 ⇒ 反过来。
    //    ⇒ 两条腿缺一不可，这正是本仓库记过 6 次的那类静默陷阱。
    //    ⚠️ 惰性（按 `accountId` 现取），不能固化成一份 fetcher。
    minimaxIntlFetchFor: minimaxIntlFetchForAccount,
  })

  // ===== 能力注册表（设计文档 §3.3）=====
  //
  // ⚠️ **本段是前瞻接线**（2026-10-08 调序后修正）：`account.refresh` 的分派
  //    **不走**这张表 —— 它查 Task 9 引入的 `auths` 形参（见 `jet-hub-rpc.ts` 的
  //    `authOf`）。本表是给**真正跨模块**的消费点用的：Task 5 的
  //    `aggregate-expiry.ts` 与 Task 8 的 `account-probe.ts` ——
  //    那两个模块拿不到 `auths` 形参。
  //
  // ⚠️ 仍必须在**所有 provider 实例都已创建之后**注册：实例要先存在。
  //
  // ⚠️ 注册的是**引用**，不是快照：`registerProviderRuntime` 只记 Map 条目，
  //    各 auth 实例的后续状态变化（凭据缓存、队列）对它透明。
  //
  // ⚠️ 这里**不注册 opencode**（它没有续期概念）与 aggregate / auto
  //    （虚拟 provider，无账号无凭据）。它们的 runtime 只有 descriptor。
  //    ⚠️ opencode 的积分也**不在** `creditsTable` 里（它的余额是本地派生的
  //    通道可用性、零网络，作为特例留在 `credits.balances` 里短路）。
  /**
   * OfficeAce 的 auth **不是 `Service` 子类**（它导出的是纯函数集合，没有实例
   * 状态需要挂到 cordis 服务上）。但仓库的统一 auth 契约（`JetHubAuthLike`）
   * 与多条守卫用例都按 **`ctx.<provider>Auth` 服务名**取实例 —— 故这里显式
   * 把命名空间包成一个服务形状的对象。
   *
   * ⚠️⚠️ **必须「复制」模块导出，不能手工枚举**（2026-10-13 事故）：
   *    早先这里是手写的一份方法清单，`persistLogin` 加入后忘了同步 ⇒
   *    `login.poll` 调 `auths.officeace.persistLogin` 得到 `undefined`，
   *    被 catch 成「登录交换失败」—— 用户看到的是**授权完却登录失败**，
   *    而日志里只有一句被吞掉的类型错误。手工枚举的清单**必然**漂移。
   *
   * ⚠️ **不能用 `Object.create(officeaceAuth)` 继承**：赋值会沿原型链走到
   *    模块命名空间的 getter-only 属性，照样抛
   *    `Cannot set property … which has only a getter`（已实测证伪）。
   *    故一次性展开复制 —— 模块导出是静态函数，复制的是引用，不会失效。
   *
   * ⚠️ **不能直接挂模块命名空间**：同上，getter-only 会让守卫用例的 spy 崩溃。
   */
  const officeaceAuthService: typeof officeaceAuth = { ...officeaceAuth }
  // ⚠️ 以下几个需要注入 `ctx.credentials`（多账号根）：凭据存在 DSH 凭据库里
  //    按 ref 索引。不传 ⇒ 走兼容文件 `session.json`，那份是**所有账号共用**
  //    的，续期会串号（2026-10-13 改造）。
  Object.assign(officeaceAuthService, {
    refreshAccountCredential: (refName: string, pool: unknown, accountId: string) =>
      officeaceAuth.refreshAccountCredential(refName, pool as never, accountId, ctx.credentials as never),
    /**
     * 批量续期：**复用 `officeace-auth.ts` 的 `refreshAccountList`**，
     * 只把「续期某一个账号」分派到本对象的 `refreshAccountCredential`。
     *
     * ⚠️⚠️ **不要再抄一份遍历逻辑**（IKLPTZ 的真实成因）：这里原先逐字复制了
     * 模块里的那份，连注释都一样，于是「把同步的 `listAccountsByProvider`
     * 当 Promise 用」这个误判被**复制了两遍**，一个 bug 要修两处、测试也要
     * 覆盖两处。收成一份之后，`refreshAccountList` 的签名就是唯一真源。
     *
     * ⚠️ **不得直接挂模块函数 `officeaceAuth.refreshAll`**：那份走的是**没有
     * `ctx.credentials`** 的兼容文件腿，多账号下会串号（2026-10-13 改造）。
     * 这里必须走本对象 —— 它的 `refreshAccountCredential` 才注入了凭据库。
     *
     * ⚠️ 守卫用例（`provider-runtime-wiring.spec.ts`）的判据是「布桩在
     * `ctx.officeaceAuth.refreshAccountCredential` 上，然后断言 `refreshAll`
     * 打到它」。故这里**必须**经 `officeaceAuthService` 取方法（走本对象），
     * 绕开它去调模块函数 ⇒ spy 收不到，用例静默少一家覆盖。
     */
    refreshAll: (pool: unknown) => officeaceAuth.refreshAccountList(
      pool,
      (account) => officeaceAuthService.refreshAccountCredential(
        account.credentialRef, pool, account.id,
      ),
    ),
  })
  {
  /**
   * OfficeAce 的 auth 服务形状包装（`officeaceAuthService`）—— 定义在下方
   * 的能力注册段里。它必须与 `ctx.provide("officeaceAuth", …)` 及
   * `registerJetHubRpc` 的 `auths.officeace` 是**同一个对象**（守卫用例布桩在
   * ctx 上，两处各建一个会让 spy 收不到调用；理由见定义处注释）。
   */
    const registry: ReadonlyArray<readonly [string, JetHubAuthLike]> = [
      ['codearts', service],
      ['buddy', buddy],
      ['workbuddy', workbuddy],
      ['lobsterai', lobsterai],
      ['qoder', qoder],
      ['qodercn', qoderCn],
      ['trae', trae],
      ['cline', cline],
      ['loomy', loomy],
      ['raccoon', raccoon],
      ['minimax', minimax],
      // ⚠️ MiniMax Code 国际版：与 `minimax` **共用同一个 `MinimaxAuth` 类**，
      //    故键与值都是它自己那个实例（`minimaxintl`）。写成 `minimax: minimaxIntl`
      //    这类错位会让国际站账号的续期去刷国内站凭据（同族串接，本仓库复发过 6 次）。
      ['minimaxintl', minimaxIntl],
      ['zcode', zcode],
      ['gemini', gemini],
      // OfficeAce（华为 MaaS 云端直连）：值是 **auth 服务形状的包装对象**
      //（`officeaceAuthService`，不是 Service 实例）—— 必须与
      // `ctx.provide('officeaceAuth', …)` 及 `registerJetHubRpc` 的
      // `auths.officeace` 是**同一个对象**，否则守卫用例布在 ctx 上的 spy
      // 收不到本循环的调用（实测症状：`续期没有分派到它自己的实例（实际：无）`）。
      ['officeace', officeaceAuthService as unknown as JetHubAuthLike],
      ['autoclaw', autoclaw],
      // ⚠️ AutoClaw 国际版：与 `autoclaw` **共用同一个 `AutoclawAuth` 类**，
      //    故键与值都是它自己那个实例（`autoclawIntl`）。写成 `autoclaw: autoclawIntl`
      //    这类错位会让国际站账号的续期去刷国内站凭据（同族串接，本仓库复发过 6 次）。
      //    漏加这一行 = 它不进注册表 ⇒ 续期/积分/探测三条链路**全部静默失效**
      //    （`provider-runtime-wiring.spec.ts` 会点名 `autoclawintl 未注册`）。
      ['autoclawintl', autoclawIntl],
      ['accio', accio],
      // AStudio（讯飞 AstronStudio）：值是 AstudioAuth 服务实例 —— 它已在构造时
      // provide 自己（服务名 astudioAuth），必须与 registerJetHubRpc 的 auths.astudio
      // 是**同一个对象**，否则守卫用例布在该实例上的 spy 收不到本循环的调用。
      // 实测签名可结构化匹配 JetHubAuthLike（refreshAccountCredential(refName, pool?,
      // accountId?) 的可选形参可接收必填实参；refreshAll(pool) 完全一致），
      // 故**不需要**上面 officeace 那样的 as unknown as JetHubAuthLike 包装。
      ['astudio', astudio],
      // ⚠️ **本 fork 独有**的 provider（上游 rc.11 仍无 modelscope）。
      //    漏加这一行 = 它不出现在注册表里 ⇒ 续期/积分/探测三条链路全部静默失效。
      ['modelscope', modelscope],
    ]
    // ★ 本 fork：按白名单过滤（续期定时器 / 积分领取 / 探测只挂保留的渠道）。
    //   ⚠️ 不过滤也能跑，但那会给已关掉的渠道白白起 30 分钟一次的续期定时器，
    //   并在设置页留下没有 UI 的命名空间。
    for (const [id, auth] of registry.filter(([id]) => isChannelAllowed(id))) {
      const descriptor = descriptorOf(id)
      if (descriptor === undefined) {
        // ⚠️ 不静默跳过：registry 与这里的清单漂移会表现为「某个 provider 的功能没了」。
        ctx.logger?.warn?.(`[jet-hub] provider registry 缺少声明：${id}`)
        continue
      }
      // ⚠️ 返回值必须判：`false` 表示「已存在、跳过了本次」——
      //    那发生在 **fiber 重启竞态**（新 apply 与旧 dispose 交错），是正常现象，
      //    记一条 info 即可（不是错误）。静默忽略会让「某个 provider 的注册被跳过」
      //    在日志里无痕。
      const registered = registerProviderRuntime({
        descriptor,
        auth: {
          // ⚠️ 只传三个参数、顺序固定 —— 各家的 `refreshAccountCredential` 签名一致
          //（本插件的统一 auth 契约）。包一层而不是直接挂方法引用：直接挂会让
          // `this` 丢失（各家方法内部用 `this.product` / `this.ctx`）。
          refreshAccount: (refName, pool, accountId) =>
            auth.refreshAccountCredential(refName, pool, accountId),
          // ⚠️ **每个会写限流标记的家都要挂**：漏一家 ⇒ 该家凭据**永不自动续期**，
          //    而症状是「每隔一段时间就要重新登录」，且日志里一个字都没有。
          // ⚠️ **真正锁住这件事的只有 `provider-runtime-wiring.spec.ts`**
          //    （它真跑 `apply()`，再逐个驱动 `auth.refreshAll` 并断言打到
          //    **自己那个**实例）。2026-10-08 独立复审修正原注释：它原先点名
          //    `refresh-targets-derived.spec.ts` 与 `refresh-bootstrap-wiring.spec.ts`
          //    各有一条 —— 实测**两者都不 import `index.ts`**，
          //    它们注册的是**自己的桩**再断言桩，改坏本段循环它们照样全绿
          //    （`refresh-targets-derived.spec.ts` 的用例⑦ 现锁的是
          //    `modelAdapters` 的键，与本段无关）。
          // ⚠️ 包一层而不是直接挂方法引用：直接挂会让 `this` 丢失
          //   （各家 `refreshAll` 内部用 `this.product` / `this.ctx`）。
          refreshAll: (pool) => auth.refreshAll(pool),
        },
        // ⚠️ `creditsOf` 而非 `creditsTable[id]`：`in`/下标会命中原型链上的键
        //（如 `constructor`），与 `jet-hub-rpc.ts` 的 `authOf` 同因。
        // ⚠️ qoder 系**没有** credits 条目（形态不匹配，是特例），故这里
        //    对它们是 `undefined` —— 如实表达「该渠道不在表里」。
        credits: creditsOf(creditsTable, id),
        // ⚠️ 与 credits 同法：`onboardingOf` 而非下标（原型链键误判）。
        // ⚠️ 只有 loomy / raccoon 有条目 —— 其余如实为 `undefined`。
        onboarding: onboardingOf(onboardingTable, id),
        // ⚠️ 与 credits / onboarding 同法：`expiryOf` 而非下标（原型链键误判）。
        // ⚠️ 只有**已接入临期折算**的渠道有条目 —— 其余如实为 `undefined`
        //    （那是「未接入」的诚实表达：`credentialExpiry` 据此返回 `UNUSABLE`）。
        //    ⚠️ `WIRED_EXPIRY_PROVIDERS` **不**从这里派生（它是编译期常量），
        //    两者的一致性由 `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死。
        expiry: expiryOf(expiryTable, id),
        // ⚠️ 与其余域同法：`probeById[id]` 用 `Object.hasOwn` 语义（下标会命中原型链）。
        // ⚠️ **`probeById` 已登记全部会写限流标记的家**（判据 = `probeById` 头注释
        //    里那两条 grep；权威清单 = `tests/helpers/provider-sets.ts` 的
        //    `WRITES_RATE_LIMIT_PROVIDERS`），
        //    其余如实为 `undefined`（`adapterForProbe` 据此抛「不支持重测」，
        //    不落回 CodeArtsAdapter）。
        //    ⚠️ **刻意不写「几家」、也不抄名单**：本句曾写「现登记 **12 家**」，
        //    实测顶层键是 13；2026-10-11 加入 `minimax`（issue IKJW32）后是 14 ——
        //    同一事实的多份抄写必然漂移（`probeById` 头注释、本段、
        //    `account-probe.ts` 的判据都各抄过一份）。数字与名单一律看
        //    `probeById` 的键与 `WRITES_RATE_LIMIT_PROVIDERS`，两边由守卫双向比对。
        //    ⚠️ 原注释写「只有 zcode / gemini / trae 注册」，那是 Task 8 计划里的
        //    **样例**被留在了原地（2026-10-08 独立复审发现）；完整名单与缺项
        //    见 `probeById` 自己的头注释（别在这里再抄一份易腐的清单）。
        ...Object.hasOwn(probeById, id) ? { probe: probeById[id] } : {},
      })
      if (!registered) {
        ctx.logger?.info?.(
          `[jet-hub] provider runtime "${id}" 已注册（插件 fiber 重启竞态），跳过本次`,
        )
      }
    }

  /**
   * ⚠️⚠️ **codely 的 runtime 必须单独注册**（2026-10-22 合并审计修，真实可达缺陷）。
   *
   * ## 缺陷（实测）
   *
   * `probeById.codely` 已登记（上面那个模块级常量里键存在），但 `probe` 域
   * **只在上面的 `for (const [id, auth] of registry)` 循环体内**被挂上
   * （`...Object.hasOwn(probeById, id) ? { probe: probeById[id] } : {}`），
   * 而 codely **不在**那个 20 项 `registry` 数组里（它是 `channel:false`、无 auth 服务）
   * ⇒ `runtimeOf('codely') === undefined` ⇒ `adapterForProbe()` 抛
   * 「codely 没有探测适配器（该 provider 不支持重测）」。
   *
   * 实测后果：
   * - `account.retest`（重测）**恒抛错**，冒泡成「操作失败：codely 没有探测适配器」；
   * - `account.test`（测试）返回 `{"ok":false,"message":"无法确认：codely 没有探测适配器…"}`；
   * - 只有 `account.reset` 能用（它不需要 probe）。
   *
   * ⚠️ 而 `probeById.codely` 的头注释与 `provider-registry.ts` 的 codely 条目
   * 都写着「『重测 / 重置』有真实作用对象」—— **只有「重置」成立**，本次一并订正。
   *
   * ## 为什么不在 `registry` 数组里加一行
   *
   * 那个数组元素类型是 `readonly [string, JetHubAuthLike]`，而 codely **没有 auth
   * 服务**（登录与余额都是自由函数）。硬塞一个假 auth 会让 `auths.codely` 出现、
   * 进而让 `expectedProviderIdsWithAuth()` 派生出的**一批**守卫变红，且
   * `account.refresh` 会对一个没有 refresh 实现的渠道开绿灯。
   * ⇒ 用「**只注册 runtime、不带 auth**」这一最小形态：`ProviderRuntime.auth` 本就是
   * 可选字段（`provider-runtime.ts` 的 `readonly auth?:`），opencode 同样没有它。
   *
   * ## ⚠️ 守卫（本次一并补）
   *
   * `provider-runtime-wiring.spec.ts` 新增「`probeById` 的每一项都真的挂到了
   * runtime」—— 原来的存在性守卫只比 `Object.keys(probeById)` 与期望集合，
   * **不查「这一项是否真被挂上」** ⇒ `probeById.codely` 存在即算通过，尽管它
   * 永远不可达（`opencode` 是同一盲区的**存量**受害者，本次一并覆盖）。
   */

  const codelyRuntimeDescriptor = descriptorOf(CODELY_PROVIDER_ID)
  if (codelyRuntimeDescriptor !== undefined && isChannelAllowed(CODELY_PROVIDER_ID)
    && Object.hasOwn(probeById, CODELY_PROVIDER_ID)) {
    registerProviderRuntime({
      descriptor: codelyRuntimeDescriptor,
      // ✅ **给 `auth`**（2026-10-22 A6）：`CodelyAuth` 已改为 `extends Service`、签名已符合
      //    `JetHubAuthLike`（单参 `refreshAll(pool)`），且真有 refresh 端点。
      //    ⚠️ **必须给**：`wiredRefreshTargets()` 遍历的是 runtime 里的 `auth.refreshAll`，
      //    不给它 ⇒ codely 永不进批量续期表 ⇒ 凭据过期后积分行报「未登录」且日志零字
      //    （issue IKKHL5 形态）。
      auth: {
        // ⚠️ 必须包一层（与上面主循环同因）：直接挂方法引用会丢 `this`。
        refreshAccount: (refName, pool, accountId) =>
          codelyAuth.refreshAccountCredential(refName, pool, accountId),
        refreshAll: (pool) => codelyAuth.refreshAll(pool),
      },
      // ⚠️ 这两行不能少：`creditsOf` 返回 `undefined` 时，
      //    `provider-runtime-wiring` 那条「声明了 balance 就必须挂 credits 域」就会点名。
      credits: creditsOf(creditsTable, CODELY_PROVIDER_ID),
      // ⚠️ codely **未接临期折算**（上游不下发到期时间）⇒ 本行取到 `undefined`。
      //    这与 `expiry-runtime-parity.spec.ts` 的显式豁免表一致。
      expiry: expiryOf(expiryTable, CODELY_PROVIDER_ID),
      probe: probeById[CODELY_PROVIDER_ID],
    })
  }

  }

  /**
   * OfficeAce 的 auth **不是 `Service` 子类**（它导出的是纯函数集合，没有实例
   * 状态需要挂到 cordis 服务上）。但仓库的统一 auth 契约（`JetHubAuthLike`）
   * 与多条守卫用例都按 **`ctx.<provider>Auth` 服务名**取实例 —— 故这里显式
   * 把命名空间包成一个服务形状的对象。
   *
   * ⚠️ **必须包一层普通对象，不能直接挂模块命名空间**：ES 模块的命名空间对象
   * 只有 getter，守卫用例会把 `refreshAccountCredential` 换成 spy（`vi.fn()`）
   * ⇒ 直接挂会抛 `Cannot set property … which has only a getter`。
   *
   * ⚠️⚠️ **同一个对象必须同时用于 `ctx.provide` 与 `registerJetHubRpc` 的
   * `auths.officeace`**：守卫用例的判据是「布桩在 `ctx.officeaceAuth` 上，
   * 然后断言 `account.refresh` 打到**同一个**实例」。两处各建一个包装对象
   * 会让 spy 永远收不到调用（实测症状：`expected [] to deeply equal
   * ['officeaceAuth']`）。
   *
   * ⚠️ 不注册的话症状是「OfficeAce 的凭据永不自动续期」且日志里一个字都没有
   *（`provider-runtime-wiring.spec.ts` 真跑 apply 会红）。
   */

  registerJetHubRpc(ctx, pool, {
    codearts: service,
    buddy, workbuddy, lobsterai, qoder,
    qodercn: qoderCn,
    trae, cline, loomy, raccoon, minimax,
    // ⚠️ 键是 **provider id** `minimaxintl`，值是变量 `minimaxIntl`
    //（两者大小写不同：id 全小写、变量名带驼峰）—— 写成简写 `minimaxintl,`
    // 会去引用一个不存在的变量。与上面 `qodercn: qoderCn` 同因。
    minimaxintl: minimaxIntl,
    zcode, gemini,
    // OfficeAce（华为 ModelArts MaaS 云端直连）：值是 **auth 服务形状的包装对象**
    //（纯函数集合 + 统一 auth 契约），不是 Service 实例。
    officeace: officeaceAuthService as never,
    // ✅ **Codely 的续期对象已接**（2026-10-22 A6）：`CodelyAuth` 签名已改成
    //    契约的**单参** `refreshAll(pool)`（与各家同形，见 A5 的修）。
    //    ⚠️ 它同时进了 `SELF_HEAL_REFRESHABLE_PROVIDERS`（`jet-hub-rpc.ts`）——
    //    两处**缺一不可**：只挂 auths 而不进自愈表 ⇒ 积分行过期后报「未登录」
    //    且日志零字（issue IKKHL5 形态，均已复发四次）。
    codely: codelyAuth,
    autoclaw,
    // ⚠️ 键是 **provider id** `autoclawintl`，值是变量 `autoclawIntl` ——
    //    两者不同名（id 全小写、变量带驼峰），写成简写会引用不存在的变量。
    //    ⚠️ 值必须是**国际版实例**：写成 `autoclaw` 会让国际站账号的续期
    //    去刷国内站凭据（与 minimaxintl 的同类风险完全一致）。
    autoclawintl: autoclawIntl,
    accio,
    astudio,
    // ⚠️ **本 fork 独有**（modelscope，2026-10-16）。漏加 = 客户端把它当
    //    「客户端已登记但宿主没有同名键」⇒ zcode-wiring 的守卫会红，
    //    且 大肥鱼饭碗 的 modelscope 面板所有 RPC 全部 `unknown provider`。
    modelscope,
  }, modelAdapters)

  // 网关是旁路功能：这里传 `pool` 只为读设置页里的开关，其内部任何失败都已
  // 自行降级为日志，绝不会让插件 apply() 失败。
  mountOpenAiGateway(ctx, pool)
  // 思考死循环被中止后的**自动续跑**：把此前必须由用户手打「继续」的那一步
  // 自动化（真实报障 2026-10-04，见 `loop-recovery.ts` 模块头）。
  // ⚠️ 它依赖 `agents` 服务，故内部用 `ctx.inject(['agents'], …)` 挂载：
  // 该服务缺席的 profile 里本功能整体不生效，不会让插件永久 pending。
  installLoopResume(ctx)
  // 官方 `web_search` 在**支持原生搜索的渠道**下改走渠道自带后端
  //（其余渠道 `next()` 放行，官方链路逐字节不变）。
  //
  // | 渠道 | 原生后端 |
  // |---|---|
  // | buddy / workbuddy | 腾讯 `/agenttool/v1/search`（Bearer） |
  // | qoder / qodercn | Qoder `/api/v1/webSearch/oneSearch`（WASM 签名） |
  //
  // ⚠️ 传**聊天链路用的那些适配器实例**：搜索与聊天因此共用同一个
  // `resolveCredential`（enabled / 模型级限流 / 免费判定 / 余额分档 / 池兜底
  // 六步完全一致，见 `web-native.ts` 模块头）。
  // ⚠️ **不接管 `web_fetch`**：官方 fetch 走 `http` 提供方、不发送凭据、零配置，
  // 接管它是净损失（2026-10-14 实测，理由见 `web-native.ts` 模块头）。
  // ⚠️ 总开关传**函数**而不是布尔值：用户在 大肥鱼饭碗 面板里切换后必须立即生效，
  // 不能被启动时的快照钉死。
  installWebNative(
    ctx,
    {
      buddy: buddyAdapter,
      workbuddy: workbuddyAdapter,
      qoder: qoderAdapter,
      qodercn: qoderCnAdapter,
    },
    () => pool.nativeWebSearchEnabled(),
  )
  ctx.provide('accountPool', pool)
  // ⚠️ 与 `registerJetHubRpc` 的 `auths.officeace` 是**同一个对象**
  //（理由见上面 `officeaceAuthService` 的注释：两处各建一个会让守卫用例的
  //  spy 收不到调用）。
  ctx.provide('officeaceAuth', officeaceAuthService as never)
  // ⚠️ **本 fork 独有**（modelscope）：`ModelscopeAuth extends Service`，
  //    构造时已由 cordis 自动注册为 `ctx.modelscopeAuth`（`super(ctx, `${product.id}Auth`)`），
  //    故这里**不需要**再 provide —— 与 accio 同款（它也没有 provide 行）。
}

