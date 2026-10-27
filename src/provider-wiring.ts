/**
 * **provider 接线层** —— `apply()` 里那 2000 行「谁接谁」的搬出地。
 *
 * ## 为什么单独一个文件
 *
 * 架构审查 ⑨ 指出 `src/index.ts` 是 God module（5551 行，其中 `apply()` 一个
 * 函数就占 4623 行）。但这 4623 行里真正「有分支的部分」不多 —— 大部分是
 * **一个 provider 接一个 provider 的装配段**：造 auth 实例、接凭据解析器、
 * 接余额选择器、接目录来源、注册 LLM 适配器。它们彼此没有控制流耦合，
 * 只是顺序排在一起，于是把入口文件撑成了迷宫。
 *
 * 这一层被搬出来的判据是「**它不决定任何事**」：
 *
 * - 没有分支（没有 `if` 决定「装不装某个 provider」——那由 `ALLOWED_CHANNELS`
 *   闸门在更上游决定，见 `src/index.ts` 的导入期过滤）；
 * - 没有顶层 `await`（全部 `await` 都在箭头函数体内，跑在请求路径上）；
 * - 没有对外部变量的赋值（唯一的写是 `buddy.lastCatalogOutcome` 这类
 *   对象属性，随实例返回）；
 * - 不碰 `ctx.effect` / `ctx.on` 这类生命周期注册（那些留在 `apply()` 里，
 *   因为它们决定「插件卸载时清理什么」，属于策略不是装配）。
 *
 * 于是它天然是一个**纯函数**：给定 `ctx`、账号池、凭据服务、余额缓存与两个
 * 图片桥接工厂，返回装配好的实例与错误分类器。`apply()` 只负责按真实顺序
 * 调用它并解构。
 *
 * ## 为什么参数里有 `makeReadImage`
 *
 * 两个图片桥接（`makeReadImage` / `makeReadImageRequest`）**刻意留在
 * `src/index.ts`**：`tests/unit/plugin.spec.ts` 从 `index.js` 导出它们做人脸缺失
 * 场景的行为用例，而 region 之后的十几个适配器（gemini / zcode / …）也还在用。
 * 若把它们搬到这里，`index.ts` 就得反过来 import 本模块 —— 循环依赖。
 * 所以改成**传入工厂**：本模块每次要图片能力时调 `makeReadImage(ctx)`，
 * 与搬走之前逐字一致。
 *
 * ## 维护约定
 *
 * 新增 provider 时把它接在这份文件里（而不是 `apply()` 里）；新增的
 * 「给 index.ts 后续使用的实例」必须加进 `ProviderWiring` 接口并在尾部
 * 的 return 里列出，否则 `apply()` 解构不到。
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { allAccountsRateLimitedForModel, type AccountPool } from './account-pool.js'
import { installAnalyzeImage } from './analyze-image.js'
import { registerBuddyLlm } from './buddy-adapter.js'
import { BUDDY_CREDENTIAL_REF, BuddyAuth, createPoolRefresh } from './buddy-auth.js'
import { buddyExpiringWindowDays } from './buddy-balance-rank.js'
import { BuddyBalanceSelector } from './buddy-balance-selector.js'
import type { BuddyNoAccountReason } from './buddy-balance-selector.js'
import { isBuddyCatalogComplete } from './buddy-oauth.js'
import type { BalanceCache } from './balance-cache.js'
import { registerClineLlm } from './cline-adapter.js'
import { ClineAuth } from './cline-auth.js'
import { CLINE } from './cline-product.js'
import type { ClineCredential } from './cline.js'
import { NO_FREE_MODEL, createCredentialResolver } from './credential-resolver.js'
import type { CreditBalance } from './credits.js'
import { setGeminiProxyPool } from './gemini-proxy.js'
import type { ImageRequestTarget } from './image-budget.js'
import { PROVIDER as CODEARTS_PROVIDER, codeartsImagePart, codeartsVisionModel, registerCodeArtsLlm } from './llm-adapter.js'
import { registerLobsteraiLlm } from './lobsterai-adapter.js'
import { LobsteraiAuth } from './lobsterai-auth.js'
import { fetchLobsteraiCreditBalance } from './lobsterai-credits.js'
import { LOBSTERAI } from './lobsterai-product.js'
import type { LobsteraiCredential } from './lobsterai.js'
import { parseLoomyRemoteModels, registerLoomyLlm } from './loomy-adapter.js'
import { LoomyAuth } from './loomy-auth.js'
import { LoomyBalanceSelector } from './loomy-balance-selector.js'
import type { LoomyNoAccountReason } from './loomy-balance-selector.js'
import { LOOMY } from './loomy-product.js'
import type { LoomyCredential } from './loomy.js'
import { registerMinimaxLlm } from './minimax-adapter.js'
import { MinimaxAuth } from './minimax-auth.js'
import { fetchMinimaxCreditBalance } from './minimax-credits.js'
import { MINIMAX, MINIMAX_INTL } from './minimax-product.js'
import { minimaxIntlFetchForAccount, setMinimaxProxyPool } from './minimax-proxy.js'
import type { MinimaxCredential } from './minimax.js'
import { isRemoteCatalogComplete } from './models.js'
import { CODEBUDDY, WORKBUDDY } from './product.js'
import { registerQoderLlm } from './qoder-adapter.js'
import { QoderAuth } from './qoder-auth.js'
import { fetchQoderCreditBalance } from './qoder-credits.js'
import { QODER, QODER_CN } from './qoder-product.js'
import type { QoderCredential } from './qoder.js'
import { registerRaccoonLlm } from './raccoon-adapter.js'
import { RaccoonAuth } from './raccoon-auth.js'
import { RACCOON } from './raccoon-product.js'
import type { RaccoonCredential } from './raccoon.js'
import { CODEARTS_CREDENTIAL_REF, type CodeArtsAuth } from './service.js'
import { reportLedgerAccount } from './token-ledger.js'
import { registerTraeLlm } from './trae-adapter.js'
import { TraeAuth } from './trae-auth.js'
import { fetchTraeCreditBalance } from './trae-credits.js'
import { TRAE } from './trae-product.js'
import type { TraeCredential } from './trae.js'
import type { BuddyCredential, CodeArtsCredential } from './types.js'

/** `makeReadImage(ctx)` 的返回型（与 `src/index.ts` 的同名函数一致）。 */
export type ReadImageFn = (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string }>

/** `makeReadImageRequest(ctx)` 的返回型（与 `src/index.ts` 的同名函数一致）。 */
export type ReadImageRequestFn = (
  attachment: unknown,
  target: ImageRequestTarget,
) => Promise<{ data: Uint8Array; mediaType: string } | undefined>

/**
 * 装配全部 provider。
 *
 * **顺序有意义**：CodeArts 先注册（它是最早的 provider，历史上有依赖它先就位的
 * 判据），其余按产品族排。调整顺序前先看 `apply()` 里对返回值的解构顺序 ——
 * 那里不依赖顺序，但 `registerProviderSettings` 的 product 列表依赖
 * `ALLOWED_CHANNELS` 过滤后的集合。
 */
export function wireProviders(
  ctx: Context,
  pool: AccountPool,
  service: CodeArtsAuth,
  balanceCache: BalanceCache,
  makeReadImage: (ctx: Context) => ReadImageFn,
  makeReadImageRequest: (ctx: Context) => ReadImageRequestFn,
): ProviderWiring {
  const codearts = registerCodeArtsLlm(ctx, {
    credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
    resolveCredential: async () => {
      // CodeArts **只认账号池**，与其余五个 provider 一致。
      //
      // ⚠️ 早期它额外支持「单凭据模式」（`CODEARTS_ACCESS_TOKEN`）：登录后把凭据
      // 写到那个固定 ref，适配器在账号池取不到时回退去读它。该模式**已移除** ——
      // 登录入口只有 大肥鱼饭碗 设置页，凭据一律写入 `CODEARTS_ACCOUNT_XXX`，
      // 固定的 `CODEARTS_ACCESS_TOKEN` 不会再被写入或读取。
      //
      // 这里仍保留 `credentialRef` 选项，仅为满足适配器契约与报错文案
      // （其余 provider 同样传各自的默认 ref，但都不再作为回退来源）。
      const available = await pool.getAvailableAccount<CodeArtsCredential>('codearts', '')
      return available?.credential
    },
    // 续期按**账号池里的具体账号**走：`refreshAccountCredential` 读写的是
    // `CODEARTS_ACCOUNT_XXX`，而旧的 `service.refresh()` 读写的是已废弃的
    // 单凭据 ref —— 那会刷到另一个（不存在的）凭据上。
    refresh: async () => {
      const available = await pool.getAvailableAccount('codearts', '')
      if (available) await service.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
    },
    fetchRemoteModels: () => service.refreshModels(pool),
    // ⚠️ 完整性桥接（issue IKJVTF 复审，审计 I3）：CodeArts 的目录来自**两个**
    // 独立端点（gateway/config + snap builtin），`refreshModels` 会把各来源成败
    // 原地写进 `service.lastCatalogOutcome`。适配器据此判「这次目录完不完整」
    // —— 残缺时只展示、不永久缓存，冷却到期后可补齐。
    catalogComplete: () => {
      const outcome = service.lastCatalogOutcome
      return outcome === undefined ? undefined : isRemoteCatalogComplete(outcome)
    },
    accountPool: pool,
    // 图片字节桥接。
    //
    // ⚠️ 复用**同一个** `makeReadImage(ctx)` —— 不另写第二套（其余 14 家全走它）。
    //
    // ⚠️ 只有 VL 模型（`kimi-k2.6-vl` / `Qwen3-VL-235B`）能收图，实测文本模型
    //    发图回 `InferHub.001001020.406 The request model is not multimodal`。
    //    适配器内部按 `codeartsAcceptsImage(model)` 判定，非 VL 模型**根本不读字节**
    //    （见 `stream()` 的注释），故这里不必再加一层判据。
    readImage: makeReadImage(ctx),
  })

  /**
   * `analyzeImage`：让**纯文本模型**也能看图（用户诉求）。
   *
   * ## 为什么走适配器自己的 `stream()` 而不是 `ctx.llm.stream()`
   *
   * 直接用本适配器实例有三个好处，且都是**必须**的：
   * 1. 复用同一套凭据解析与**请求级换号**（池里哪个号能用、撞额度怎么换）；
   * 2. 复用 `codeartsAcceptsImage` 的读图闸门与 `image_url` 序列化（同一份实现）；
   * 3. 不经过 `ctx.llm` 的路由投影 —— 那条路会按**目标模型**的模态再判一遍。
   *
   * ## ⚠️ 每次识图是**一次独立的、非会话的**上游请求
   *
   * 它不写进会话历史、不占会话的 tool 轮次，与 IDE 的 `analyzeImage` 同构。
   * 故这里手工构造 `messages`（不传 `tools`、不传 system）。
   */
  const describeWithVision = async (
    imageDataUrls: readonly string[],
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const visionModel = codeartsVisionModel()
    const parts: Array<Record<string, unknown>> = [
      ...imageDataUrls.map((url) => codeartsImagePart(url)),
      { type: 'text', text: prompt },
    ]
    let text = ''
    for await (const chunk of codearts.stream({
      provider: CODEARTS_PROVIDER,
      model: visionModel,
      messages: [{ role: 'user', content: parts }],
      signal,
    } as never)) {
      const typed = chunk as { type?: string; text?: unknown }
      if (typed.type === 'text-delta' && typeof typed.text === 'string') text += typed.text
    }
    if (text.trim().length === 0) {
      // ⚠️ 空正文要**明确报错**而不是返回空串：空串会让主模型以为"图上什么都没有"，
      // 从而给用户一个自信的错误答案（本仓对「空响应」一贯如此处理）。
      throw new Error(
        `analyzeImage: 识图模型（${visionModel}）没有返回任何文字；`
        + '可能是上游排队或图片格式不被接受，请稍后重试。',
      )
    }
    return text
  }

  installAnalyzeImage(
    ctx,
    { readImage: makeReadImage(ctx), describe: describeWithVision },
    (exec) => {
      // 与官方 `read_image` 的 `assertImageCapableRoute` 同一手法：
      // 先读会话已折叠的 `request/header` 路由，再回退到 agent options。
      const agent = (exec as {
        agent?: {
          options?: { provider?: string; model?: string }
          session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
        }
      }).agent
      const routed = agent?.session?.requestHeader?.()?.config
      return {
        provider: routed?.provider ?? agent?.options?.provider,
        model: routed?.model ?? agent?.options?.model,
      }
    },
    // ⚠️ 传 logger：`DSH_DISABLE_ANALYZE_IMAGE` 关闸时必须**留一条日志**，
    //    否则「工具不见了」与「注册静默失败」同形（后者是本工具栽过的坑）。
    { info: (message: string) => ctx.logger?.info?.(message) },
  )

  // ===== Buddy (腾讯 CodeBuddy) 服务 =====
  // 不注册斜杠命令：登录/状态/续期都在 大肥鱼饭碗 设置页完成（多账号 + 账号池），
  // 命令式的单凭据入口已无必要。

  /**
   * 按凭据 ref 解析 buddy 系凭据（CodeBuddy 与 WorkBuddy **共用这一个函数**）。
   *
   * 两站凭据同构（同一 CLI 内核、同一认证协议），差别只在 endpoint；
   * 解析这件事与 endpoint 无关，故不写两份。
   */
  const resolveBuddyCredentialByRef = async (refName: string): Promise<BuddyCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as BuddyCredential
    } catch {
      return undefined
    }
  }

  /**
   * 两个 buddy 各自的**按到期分档选号器**（各自一份余额缓存，绝不串味）。
   *
   * ⚠️ **为什么需要它**：一个 buddy 账号常同时持有多种资源包（实测 WorkBuddy
   * 每个号都有「Bonus Pack（14 天到期）」+「Free Plan Subscription（扣费截止
   * 8 年后）」），而**服务端扣哪个包不由插件决定**。插件能决定的只有「用哪个号」：
   * 优先用还有「15 天内到期积分」的号（那部分再不用就作废），只剩长期积分的号
   * 排最后 —— 与「锁定永久积分」配套（锁定时后者直接判不可用）。
   *
   * 判据出处见 `buddy-balance-rank.ts`（为什么是 15 天、为什么用 DeductionEndTime
   * 而不是 CycleEndTime / ExpiredTime，都有实测对照）。
   */
  const buddyBalanceSelector = new BuddyBalanceSelector({
    product: CODEBUDDY,
    resolveCredential: resolveBuddyCredentialByRef,
  })
  const workbuddyBalanceSelector = new BuddyBalanceSelector({
    product: WORKBUDDY,
    resolveCredential: resolveBuddyCredentialByRef,
  })

  /**
   * 在「候选为空、即将退到单凭据 ref」这一刻，先证明失败原因是不是**限流**。
   *
   * ## 它修的是什么
   *
   * 症状：`/compact` 连续报「Compaction could not produce a useful summary」，
   * 而会话日志里 `compaction/end` 携带的真实错误是
   * `buddy: no usable credential; log in from the 大肥鱼饭碗 panel first` ——
   * 可当时面板里 buddy 账号**已登录、已启用**，只是它被目标模型的模型级限流
   * 标记挡住（解禁时刻就在 `modelRateLimits` 里）。
   *
   * 链路：唯一的启用账号被限流 → 候选筛成空集 →
   * `select()` 只能回一个笼统的 `exhausted`（`reason` 在未锁定时被丢弃）→
   * 退到单凭据 ref `BUDDY_ACCESS_TOKEN`，而 大肥鱼饭碗 登录只写
   * `BUDDY_ACCOUNT_XXX`、该 ref **根本不存在** → 适配器抛 `MISSING_CREDENTIAL`。
   *
   * 即：**凭据问题被误报成「没登录」，而真实原因是限流**。用户据此去重新
   * 登录，方向完全错。这与本仓库的同类病根一致 —— 用默认归类代替了对业务语义
   * 的判断。完整报障记录见 `docs/agent-notes/providers-buddy.md`。
   *
   * ⚠️ 这里**只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败
   * 仍然失败；修的是「用户看到的原因」。绝不静默换模型、也绝不绕过限流标记。
   *
   * ⚠️ **但「不改可用性」对 zcode 不成立** —— 正因如此，zcode **刻意不接**这条：
   * 其余各家的兜底读的是 大肥鱼饭碗 登录路径下**从不被写入**的 `*_ACCESS_TOKEN`，
   * 判定抛错时那条路本就取不到东西；而 zcode 的兜底 `zcode.current()` 会**再读
   * 一次账号池**且不看 `enabled`、仍能返回凭据 —— 加判定会把本来能跑通的一发
   * 变成硬失败。完整实测见 zcode 注册处那条注释。
   *
   * @param product - 目标 provider（用其 `id` 与 `displayName`）。**只要求这两个字段**：
   *   除 buddy / workbuddy 外，cline 也接这条（它同样会因模型级限流被挡住，
   *   而 `ClineProduct` 与 `BuddyProduct` 是两个类型）。
   * @param modelId - 本次请求的模型；空串时不做判定（与选号侧约定一致）。
   * @throws LlmError 带 `QUOTA_EXCEEDED` 码与解禁时刻，仅当**所有**启用账号
   *   都在该模型上受限时；其余情形静默返回，交给原有的 `MISSING_CREDENTIAL`。
   */
  const throwIfAllAccountsRateLimited = (
    product: { id: string; displayName: string },
    modelId?: string,
  ): void => {
    const limited = allAccountsRateLimitedForModel(
      // 只统计**启用**账号：停用账号本就不参与自动选号，把它们算进来会
      // 让「有一个号被停用」的普通情况被误报成「全部限流」。
      pool.listAccountsByProvider(product.id).filter(a => a.enabled),
      modelId ?? '',
    )
    if (limited === undefined) return
    throw new LlmError(
      `${product.displayName}：模型 ${modelId} 的可用账号均在限流中，`
      + `最近一个将于 ${new Date(limited.resetAtMs).toLocaleString('zh-CN')} 解禁。`
      + `可改用其它 provider / 模型，或等待解禁后再试（无需重新登录）。`,
      'QUOTA_EXCEEDED',
    )
  }

  /**
   * 「锁定永久积分 + 无可用账号」的报错文案（buddy / workbuddy / lobsterai / trae 共用）。
   *
   * ## ⚠️ 必须**分四种原因**报（与 Loomy 那条同型缺陷）
   *
   * 把「余额查询失败（一次网络抖动）」混成「额度已用尽」，用户会去解锁、
   * 或白等到明天 —— 而号其实有钱。故 `kind === 'unknown'` 单独一条文案。
   *
   * 同理，`kind === 'no-candidates'`（**一个候选都没筛出来**，余额分档压根
   * 没跑）也绝不能报「积分都已用尽」：那是在替服务端断言一件我们从没查过的
   * 事（真实报障：CodeBuddy「明明有积分却显示不可用」，见
   * `docs/agent-notes/providers-buddy.md`）。
   * ⚠️ 全被模型限流这一支已在 `credential-resolver.ts` 用
   * `throwIfAllRateLimited` 提前拦下（报出解禁时刻），故走到本分支的
   * `no-candidates` 主要是「没有任何启用中的账号」——但文案仍**并列**两种
   * 可能，不把话说死：判定本身依赖 `throwIfAllRateLimited` 被接线，
   * 谎报一个确定原因会把用户指向错误的方向。
   *
   * ⚠️ `kind === 'credential-only'`（**余额分档确实选出了有可用积分的号，
   * 只是那些号的凭据读不出来**）同样**绝不能**报「积分都已用尽」——
   * 那是**自相矛盾**（分档刚证明它有钱），且会把用户推向「解锁永久积分」
   * （不可撤回地烧钱）。这是审计实测打穿的漏网路径：
   * `pickBuddyAccount` 的 `reason` 在「候选非空但凭据全坏」时曾保持 `undefined`，
   * 被调用方的 `?? { kind: 'exhausted' }` 兜成「已用尽」。
   * 该文案必须**正向点名凭据**，并**明确劝阻解锁**。
   *
   * ## 为什么抽成函数而不是四家各写一遍
   *
   * 四家的文案**逐字相同**，只有 `displayName` 不同（`buddyExpiringWindowDays()`
   * 也在运行时解析，以便用户改窗口后文案跟着变）。各写一遍 = 改一处漏三处。
   *
   * @param displayName - 产品名（用户据此知道去哪个面板解锁）。
   */
  const buddyLockedError = (displayName: string) =>
    (reason: BuddyNoAccountReason): Error => {
      const days = buddyExpiringWindowDays()
      if (reason.kind === 'unknown') {
        return new Error(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
          + '的积分 —— 请重试，或在 大肥鱼饭碗 对应面板检查凭据是否失效。',
        )
      }
      if (reason.kind === 'no-candidates') {
        return new Error(
          `${displayName}：没有可用账号。已锁定永久积分，而本次**没有任何候选账号**`
          + '（该 provider 下没有启用中的账号，或全部账号都在本次请求的模型上受限）。'
          + `请在 大肥鱼饭碗 的 ${displayName} 面板确认账号已启用、且未全部处于限流中；`
          + '或改用其它 provider / 模型，或解锁永久积分后重试。',
        )
      }
      if (reason.kind === 'credential-only') {
        // ⚠️ **必须与「积分用尽」逐字分开**，且要**明确劝阻解锁**：解锁会不可
        //    撤回地烧掉永久积分，而本情形的根因在凭据、与积分无关。
        return new Error(
          `${displayName}：无法使用任何账号。已锁定永久积分，而余额分档**确实选出了**`
          + '有可用积分的账号 —— 但它们的**凭据读不出来**（凭据缺失 / 已失效 / 被并发续期覆盖）。'
          + '⚠️ 这与「积分用尽」是两件事，**不要去解锁永久积分**（解锁会不可撤回地烧掉它们）。'
          + `请在 大肥鱼饭碗 的 ${displayName} 面板检查这些账号的凭据，必要时重新登录。`,
        )
      }
      /**
       * ⚠️⚠️ **穷尽性守卫**：走到这里**只允许**是
       * `{ kind: 'exhausted' }` —— 它是**唯一**有事实依据可以说「积分用尽」的一档
       * （余额分档真的查过，且每个候选的可用积分都确实是 0）。
       *
       * 这里以前是**裸 `return`** 当兜底。将来给 `BuddyNoAccountReason` 再加一档时，
       * 它会**静默**落进「积分都已用尽」的文案 —— 而那句文案会把用户推向
       * 「解锁永久积分」（**不可撤回地烧钱**）。`no-candidates` 正是
       * 这个形态（它曾落进这里），故补一道**编译期**闸门，不再靠人记得改文案。
       *
       * 判据：把 `reason` 赋给**只剩 `exhausted` 那一档**的类型。若上面少接住一档
       * （`reason` 的联合里多出别的成员），`tsc` 当场报 `TS2322`
       * （联合类型不可赋给单成员类型），而不是静默退回「已用尽」文案。
       */
      const exhaustedOnly: { kind: 'exhausted' } = reason
      void exhaustedOnly
      return new Error(
        `${displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
        + '积分都已用尽。请在 大肥鱼饭碗 的 '
        + `${displayName} 面板解锁永久积分，或等待资源包到期后重新发放额度。`,
      )
    }

  /**
   * Qoder（`qoder` 国际版 / `qodercn` 中国版）的
   * 「锁定永久积分 + 无可用账号」报错文案。
   *
   * ⚠️ **不是漏抽 `buddyLockedError`，而是本家口径**必须**不同**：buddy 系的
   * 「临期」指服务端**资源包**（`DeductionEndTime`），而 Qoder
   * **逐包到期时刻根本拿不到**（见下）。照抄它会让用户按一个**在本家不存在**
   * 的判据去排查。
   *
   * ## ⚠️⚠️ 本家最关键的事实：**Qoder 的「临期桶」恒为 0**
   *
   * 这是本函数每一档文案都必须自洽的前提，先说清机制：
   *
   * | 事实 | 取证来源 |
   * |---|---|
   * | 上游只下发**聚合标量**（`userQuota` / `addOnQuota` 各一个 `total/used/remaining`），**没有逐包明细** | `/sash/api/v2/me/usage` 真机实测（见 `qoder-credits.ts` 文件头） |
   * | 逐包明细端点**不可用**：`/api/v1/me/quotas/{key}/histories`、`/api/v1/me/usages/big_model_credits/histories` 在 **qoder.cn 域 401**（只对浏览器登录态开放）、在 **openapi 域 404**；`/sash/*` 逐包端点全 404 | 2026-10-20 端点探测 |
   * | `usage.expiresAt` 是**永久哨兵**（`253402214400000` = `9999-12-31`），**不是**真实到期时刻 | 真机实测（同上） |
   * | 本机账号 `dedicatedResourcePackages` = `undefined`（那一路径目前取不到任何带日期的包） | 真机实测 |
   * | 到期**语义**是「领取后 30 天」（`benefit.validity = {mode:'RELATIVE_DAYS', days:30}`），但那是**活动声明**，不是某个包的**时刻** | `/sash/api/v1/me/campaigns` 真机实测 |
   *
   * ⇒ 聚合侧 `toPackage` 对**拿不到时刻**的包**不写 `deductionEndTime`**，
   * 于是 `splitBuddyCreditsByExpiry` 按**保守方向**把它们全归入**永久桶**：
   * **expiring 恒为 0**。锁定永久积分时，这样的账号一定被判 `none`（不可用）——
   * 这是**正确**行为（我们确实只能证明它只有永久积分）。
   *
   * ## 由此推出两条**文案纪律**（违反即误导）
   *
   * 1. **不得写「N 天内到期」「15 天内」这类绑定天数的说法**。Qoder 拿不到
   *    逐包时刻，任何天数都是**编造**；宿主的窗口（`buddyExpiringWindowDays()`，
   *    默认 15 天、可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖）对本家**不产生
   *    任何筛选效果**，写进文案只会让用户以为「等几天就会有临期额度可用」。
   *    ⚠️ 注意前端 `permanentLockCopy` 那一侧因为 registry 的
   *    `usesExpiryWindow: true` 会渲染出**带天数**的通用面板文案 —— 那是面板
   *    对「按到期分桶」这一能力的统一表述，**与本函数无关**；本函数是**真出
   *    故障时**用户看到的那句，必须写实际机制。
   * 2. **必须明说「解锁才能继续用」**。因为本家的临期桶恒为 0，
   *    「等一会儿就有临期额度」是**不可能发生**的事 —— 用户唯一的下一步是
   *    解锁（会消耗长期/永久积分，须如实告知）。
   *
   * ## 四档（与 buddy 同形，但措辞逐档按本家重写）
   *
   * `unknown` / `no-candidates` / `credential-only` / `exhausted`
   * —— 四者的**必要性**见 `BuddyNoAccountReason` 的定义注释，不在本处重复。
   *
   * ⚠️ **两站共用本函数，只换 `displayName`**：两站协议与端点形状逐字相同
   *（同一个 `QoderAdapter` 类、同一个 `fetchQoderCreditBalance`，差异全在
   * `QODER` / `QODER_CN` 的主机与 client_id），各写一遍 = 改一处漏一处。
   * 但 `displayName` **必须**逐站区分：两站账号不互通，用户要知道去哪个面板解锁。
   *
   * ⚠️ **本家没有 XFF / 地理分流问题**（与 MiniMax 国际站的关键差异）：
   * Qoder 两站各自有独立域名且互不 307，故**不要**照抄 minimax 文案里那段
   * 「填 `X-Forwarded-For`」的指引（照抄会让用户去改一个**不生效**的设置）。
   *
   * ⚠️ **错误码取 `QUOTA_EXCEEDED`**（与 buddy / Loomy 一致）：
   * 这确实是额度问题；且它**不在**宿主 `DEFAULT_RETRYABLE_CODES` 里，
   * 故不会被白重试 —— 锁定是**确定性**结果，重试无用。
   */
  const qoderLockedError = (displayName: string) =>
    (reason: BuddyNoAccountReason): Error => {
      if (reason.kind === 'unknown') {
        return new LlmError(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${reason.errors.slice(0, 2).join('；')}）。`
          + '这些账号**可能仍有**可消耗的额度 —— 请重试，'
          + `或在 大肥鱼饭碗 的 ${displayName} 面板检查凭据是否失效`
          + '（Qoder 的凭据有有效期，失效后需要重新登录该账号）。'
          + '⚠️ 国际版（`openapi.qoder.sh`）本机网络不通时会**每次都**查不到余额，'
          + '若你用的是国际版请先确认该域名可达。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'no-candidates') {
        return new LlmError(
          `${displayName}：没有可用账号。已锁定永久积分，而本次**没有任何候选账号**`
          + '（该 provider 下没有启用中的账号，或全部账号都在本次请求的模型上受限）。'
          + `请在 大肥鱼饭碗 的 ${displayName} 面板确认账号已启用、且未全部处于限流中；`
          + '或改用其它 provider / 模型，或解锁永久积分后重试。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'credential-only') {
        // ⚠️ **必须与「积分用尽」逐字分开**，且要**明确劝阻解锁**：解锁会不可
        //    撤回地消耗长期积分，而本情形的根因在凭据、与积分无关。
        return new LlmError(
          `${displayName}：无法使用任何账号。已锁定永久积分，而余额分档**确实选出了**`
          + '有可用额度的账号 —— 但它们的**凭据读不出来**（凭据缺失 / 已失效 / 被并发续期覆盖）。'
          + '⚠️ 这与「额度用尽」是两件事，**不要去解锁永久积分**（解锁会不可撤回地消耗它们）。'
          + `请在 大肥鱼饭碗 的 ${displayName} 面板检查这些账号的凭据，必要时重新登录。`,
          'QUOTA_EXCEEDED',
        )
      }
      /**
       * ⚠️⚠️ **穷尽性守卫**（与 buddy / Loomy 两份同型）：
       * 走到这里**只允许**是 `{ kind: 'exhausted' }`。把 `reason` 赋给单成员类型，
       * 将来 `BuddyNoAccountReason` 加了新档位却忘写文案时，`tsc` 当场报
       * `TS2322`，而不是静默落进「额度都已用尽」—— 那句会把用户推向
       * **不可撤回**的解锁操作。
       */
      const exhaustedOnly: { kind: 'exhausted' } = reason
      void exhaustedOnly
      /**
       * ⚠️⚠️ **本档文案已按事实重写**（2026-10-21 对抗性审计发现：原文案与代码行为**相反**）。
       *
       * ## 原文案错在哪
       *
       * 旧文案逐字声称：
       * > 「Qoder 上游**只下发聚合额度、不给逐包到期时刻**，插件因此**无法确认**
       * >  哪些额度是临期的」
       * > 「说「等临期积分到期后重新发放」会让用户白等（**本家根本没有那个临期池**）」
       *
       * **两句都不成立**：`qoder-credits.ts` **确实**解析
       * `dedicatedResourcePackages[].expiresAt` 并写进 `deductionEndTime`
       *（支路 B，`e1d9bf1` + `1e1b6bb` 还专门加了旗标/哨兵判据）⇒
       * 一旦上游下发该字段，插件**完全能确认**哪些额度是临期的。
       *
       * 实测反例（构造报文，本机）：
       * ```
       * dedicatedResourcePackages: [{ remaining: 800, expiresAt: NOW + 60d }]
       * → split = { expiring: 0, permanent: 2500 }
       * ```
       * 该账号被判 `none`（正确，60 天后才到期、超出 15 天窗口），但**再等约 45 天**
       * 这个包就会自己进入临期档、账号自动恢复可用 ——「白等」这句恰好说反了：
       * 用户等下去**真的会**有临期额度。
       *
       * ## 为什么原文案会写成那样
       *
       * 它把「**本机两个账号**的 `dedicatedResourcePackages` 恰好是 `undefined`」
       * （一个**样本偶然**）写成了「上游**从不**下发」（一个**通用前提**）。
       * 这正是本仓库反复登记的那类错误：**样本缺失 ≠ 字段不存在**。
       *
       * ## 新文案的口径（三条纪律）
       *
       * 1. **不声称「拿不到逐包到期」** —— 拿到了就用；没拿到才落永久桶。
       * 2. **不写死天数**：15 天窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，
       *    写死数字会在用户改配置后自相矛盾。
       * 3. **必须给出「解锁」这条确定的出路**（这是唯一能立即恢复的操作），
       *    同时**如实提示**「若你的账号有带到期日的资源包，等它进入窗口后会自愈」
       *    —— 那是事实，不是安抚。
       */
      return new LlmError(
        `${displayName}：没有可用账号。已锁定永久积分，而当前账号的额度都属于`
        + '**长期 / 永久**那一类（要么上游没给逐包到期时刻，要么到期日还在'
        + '「临期窗口」之外 —— 窗口默认 15 天，可由 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 调整）。'
        + '⚠️ 锁定永久积分时，**无法证明有临期额度**的账号会被判为不可用'
        + '（宁可少用一个号，也不要把长期额度误当临期烧掉）—— 这是锁定的**预期效果**。'
        + `请在 大肥鱼饭碗 的 ${displayName} 面板**解锁**永久积分后继续使用`
        + '（解锁会真的消耗那些长期/永久额度）；'
        + '若你的账号确实有带到期日的资源包（`dedicatedResourcePackages`），'
        + '等它进入临期窗口后本账号会自动恢复可用，无需其它操作。',
        'QUOTA_EXCEEDED',
      )
    }

  /**
   * AStudio 的「锁定永久积分 + 无可用账号」报错文案。
   *
   * ⚠️ **不是漏抽 `buddyLockedError`**，而是本家口径**必须**不同：
   * buddy 系的「临期」指「服务端资源包 `DeductionEndTime` 距今 < 15 天」，
   * 而 AStudio 的三个池语义是**会员 / 购买 / 赠送（活动）积分**，
   * 只有「赠送积分」实测带 `activityNextExpireTime`（会员与购买两池实测
   * 为 `null`，即长期有效）。用户按 buddy 那句「等待资源包到期后重新发放额度」
   * 去排查会找不到对应的东西。
   *
   * ⚠️ 若将来 `astudio-credits.ts` 的池分类变了（例如会员池也开始下发改期），
   * 本函数里的池名要跟着改 —— 它是**唯一**被用户看到的池名清单。
   *
   * ⚠️ 错误码取 `QUOTA_EXCEEDED`（与 buddy 系一致：这确实是额度问题，
   * 且不会像 `AUTH` 那样在部分客户端把 message 吞掉）。
   *
   * ⚠️ **本函数放在这里（`buddyLockedError` 之后、`loomyLockedError` 之前）是
   *    历史的偶然，不是约束**：它只用 `BuddyNoAccountReason`，与 buddy 三份同族，
   *    放哪都不影响正确性。**不要**为了让某个按位置切片做断言的既有用例通过而
   *    调整本函数的声明顺序 —— 2026-10-20 我一度这么做（那时
   *    `loomy-balance-error-contract.spec.ts` 的 `lockedErrorBody()` 用
   *    `indexOf('const buddy = new BuddyAuth')` 当切片终点，恰好把本函数圈了进去，
   *    于是本家 `QUOTA_EXCEEDED` 被当成 Loomy 的码核对而变红）。
   *    正确修法是**把那条断言的切片终点改精确**（改成「下一个同级 `const`」），
   *    已在该 spec 里改并写明理由。断言描述的是「这个函数用了哪些码」，
   *    不是「这个函数后面跟着谁」。
   */
  const astudioLockedError =
    (displayName: string) =>
    (reason: BuddyNoAccountReason): Error => {
      const days = buddyExpiringWindowDays()
      if (reason.kind === 'unknown') {
        return new LlmError(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
          + '的积分 —— 请重试，或在 大肥鱼饭碗 的 AStudio 面板检查凭据是否失效'
          + '（AStudio 的凭据是本机客户端会话的拷贝，客户端退出登录会让它失效）。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'no-candidates') {
        return new LlmError(
          `${displayName}：没有可用账号。已锁定永久积分，而本次**没有任何候选账号**`
          + '（该 provider 下没有启用中的账号，或全部账号都在本次请求的模型上受限）。'
          + `请在 大肥鱼饭碗 的 ${displayName} 面板确认账号已启用、且未全部处于限流中；`
          + '或改用其它 provider / 模型，或解锁永久积分后重试。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'credential-only') {
        // ⚠️ **必须与「积分用尽」逐字分开**，且要**明确劝阻解锁**：解锁会不可
        //    撤回地烧掉永久积分，而本情形的根因在凭据、与积分无关。
        return new LlmError(
          `${displayName}：无法使用任何账号。已锁定永久积分，而余额分档**确实选出了**`
          + '有可用积分的账号 —— 但它们的**凭据读不出来**（凭据缺失 / 已失效 / 被并发续期覆盖）。'
          + '⚠️ 这与「积分用尽」是两件事，**不要去解锁永久积分**（解锁会不可撤回地烧掉它们）。'
          + `请在 大肥鱼饭碗 的 ${displayName} 面板检查这些账号的凭据；AStudio 没有 OAuth 授权页，`
          + '需要在 AStudio 客户端登录后用「导入本机会话」重建凭据。',
          'QUOTA_EXCEEDED',
        )
      }
      /**
       * ⚠️⚠️ **穷尽性守卫**（与 buddy / Loomy 两份同型）：走到这里**只允许**是
       * `{ kind: 'exhausted' }`。把 `reason` 赋给单成员类型，将来
       * `BuddyNoAccountReason` 加了新档位却忘写文案时，`tsc` 当场报 `TS2322`，
       * 而不是静默落进「积分都已用尽」—— 那句会把用户推向不可撤回的解锁操作。
       */
      const exhaustedOnly: { kind: 'exhausted' } = reason
      void exhaustedOnly
      /**
       * ⚠️⚠️ **本段文案已按代码实际行为重写**（2026-10-21 对抗性审计发现）。
       *
       * ## 原文案错在哪
       *
       * 旧文案把「临期」**唯一归给赠送池**：
       * > 「所有账号的「N 天内到期」积分（AStudio 的**赠送/活动积分**池）都已用尽。
       * >  会员积分与购买积分**通常是长期有效的**，锁定状态下动不到它们。」
       *
       * 而 `astudio-credits.ts` 的三个池（会员 / 购买 / 赠送）**同等地**走
       * `pushPool(...)`，各自把自己的 `{member,buy,activity}NextExpireTime`
       * 归一化进 `deductionEndTime` ⇒ **任何一个池**有窗口内到期都会被算进临期桶。
       *
       * 实测反例（构造报文，本机）：
       * ```
       * { memberBalance: 800, memberNextExpireTime: NOW+4d,
       *   buyBalance: 1000,   buyNextExpireTime: null,
       *   activityBalance: 0 }
       * → split = { expiring: 800, permanent: 1000 }
       *    ↑ 临期 800 **全部来自会员池**，赠送池一分没有
       * ```
       * ⇒ 用户拿着旧文案去「查赠送池」会一无所获，而真正快到期的在**会员池**。
       *
       * ## 旧文案为什么会写成那样
       *
       * 它把「本机实测时会员/购买两池的 `NextExpireTime` 恰好是 `null`」
       * 写成了「通常是长期有效的」这个**通用结论**。同一个错误的另一形态：
       * **样本偶然 ≠ 字段语义**。
       *
       * ## 新文案的口径
       *
       * 1. **三个池平等列出**（会员 / 购买 / 赠送），不猜哪个有到期；
       * 2. 保留 `days`（本家 `usesExpiryWindow: true`，那个天数**确实**是筛选判据，
       *    与 Qoder 不同 —— 那里拿不到逐包时刻、写天数才是编造）；
       * 3. 给出两条出路：解锁（确定可行）／等下一笔活动积分发放（若确因活动池用尽）。
       */
      return new LlmError(
        `${displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
        + '积分都已用尽。⚠️ AStudio 的**会员 / 购买 / 赠送（活动）**三个积分池'
        + '都会各自下发到期时间、都被计入临期判据 —— 不限于赠送池，'
        + '请在该账号的「资源包」明细里逐个核对（而不是只看赠送池）。'
        + `请在 大肥鱼饭碗 的 ${displayName} 面板解锁永久积分`
        + '（解锁后长期有效的部分才可用），或等待下一次活动积分发放。',
        'QUOTA_EXCEEDED',
      )
    }

  /**
   * MiniMax Code 的「锁定永久积分 + 无可用账号」报错文案。
   *
   * ⚠️ **不是漏抽 `buddyLockedError`**，而是本家口径**必须**不同：
   * buddy 系的「临期」指服务端**资源包**（`DeductionEndTime`），
   * 而 MiniMax 的到期来自 `/minimax-cloud/api/v1/credit/details` 的
   * **每条明细各自带 `expire_at_ms`**（2026-10-20 实测真实账号 20 条全部有值，
   * 到期时刻 = 发放时刻 + 30 天）。buddy 那句「等待资源包到期后重新发放额度」
   * 在 MiniMax **没有对应物** —— 它的额度来自**每日签到**与活动发放，
   * 用户按 buddy 的口径去排查会找不到那个「资源包」。
   *
   * ⚠️ 两个产品（`minimax` / `minimaxintl`）**共用本函数**，只换 `displayName`：
   * 两站的积分语义与端点形状逐字相同（同一个 `fetchMinimaxCreditBalanceDetailed`，
   * 差异只在 `MINIMAX_INTL` 的主机与 ref 前缀），各写一遍 = 改一处漏一处。
   * 但 `displayName` **必须**逐站区分：两站账号不互通，用户要知道去哪个面板解锁。
   */
  const minimaxLockedError = (displayName: string) =>
    (reason: BuddyNoAccountReason): Error => {
      const days = buddyExpiringWindowDays()
      if (reason.kind === 'unknown') {
        return new LlmError(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
          + '的积分 —— 请重试，或在 大肥鱼饭碗 的对应面板检查凭据是否失效。'
          + '⚠️ **国际站**另有地理分流风险：`agent.minimax.io` 会按出口 IP 把大陆来源'
          + ' 307 到中国站，而中国站不认国际站 token ⇒ 表现为余额查询恒失败'
          + '（issue IKMEVG）；可在面板设置里填 `X-Forwarded-For`。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'no-candidates') {
        return new LlmError(
          `${displayName}：没有可用账号。已锁定永久积分，而本次**没有任何候选账号**`
          + '（该 provider 下没有启用中的账号，或全部账号都在本次请求的模型上受限）。'
          + `请在 大肥鱼饭碗 的 ${displayName} 面板确认账号已启用、且未全部处于限流中；`
          + '或改用其它 provider / 模型，或解锁永久积分后重试。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'credential-only') {
        // ⚠️ **必须与「积分用尽」逐字分开**，且要**明确劝阻解锁**：解锁会不可
        //    撤回地烧掉永久积分，而本情形的根因在凭据、与积分无关。
        return new LlmError(
          `${displayName}：无法使用任何账号。已锁定永久积分，而余额分档**确实选出了**`
          + '有可用积分的账号 —— 但它们的**凭据读不出来**（凭据缺失 / 已失效 / 被并发续期覆盖）。'
          + '⚠️ 这与「积分用尽」是两件事，**不要去解锁永久积分**（解锁会不可撤回地烧掉它们）。'
          + `请在 大肥鱼饭碗 的 ${displayName} 面板检查这些账号的凭据，必要时重新登录。`,
          'QUOTA_EXCEEDED',
        )
      }
      /**
       * ⚠️⚠️ **穷尽性守卫**（与 buddy / Loomy / AStudio 三份同型）：走到这里
       * **只允许**是 `{ kind: 'exhausted' }`。把 `reason` 赋给单成员类型，
       * 将来 `BuddyNoAccountReason` 加了新档位却忘写文案时，`tsc` 当场报
       * `TS2322`，而不是静默落进「积分都已用尽」—— 那句会把用户推向
       * **不可撤回**的解锁操作。
       */
      const exhaustedOnly: { kind: 'exhausted' } = reason
      void exhaustedOnly
      return new LlmError(
        `${displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
        + '积分（MiniMax 的**签到 / 活动发放**额度，每条明细自带 30 天有效期）都已用尽。'
        + '长期有效的部分在锁定状态下动不到它们。'
        + `请在 大肥鱼饭碗 的 ${displayName} 面板解锁永久积分，或等待下一次签到 / 活动发放。`,
        'QUOTA_EXCEEDED',
      )
    }

  /**
   * AutoClaw（国内站 / 国际版）的「锁定永久积分 + 无可用账号」报错文案。
   *
   * ⚠️ **不是漏抽 `buddyLockedError`**，而是本家池名**必须**不同：
   * buddy 系的「临期」指**服务端资源包**（`DeductionEndTime`），而 AutoClaw 的
   * 批次来自**钱包流水**（`wallets` + `wallet_expires_at`），且**永久桶按描述分组**
   * （`autoclaw-credits.ts` 的 `permanentByLabel`）—— 上游给什么描述就是什么包名。
   * 照抄 buddy 那句会让用户去钱包里找一个叫「资源包」的东西，而
   * AutoClaw 面板上根本没这个名字。
   *
   * ⚠️⚠️ **本函数文案不得点名具体池名**（2026-10-21 二轮审计，P1）：
   * 初版写过「活动赠送」「注册奖励」，那两个名字**没有任何实测来源**（详见
   * `exhausted` 档的注释）。仓库内实测到的真实包名是
   * 「`AutoClaw 用户登录奖励积分，7天有效`」「`每日签到`」这类**上游原样字符串**，
   * 编一个分组名会让用户照着去找、一无所获。
   *
   * ## 四档（与 buddy / minimax 同形，措辞按本家重写）
   *
   * `unknown` / `no-candidates` / `credential-only` / `exhausted` ——
   * 四者的**必要性**见 `BuddyNoAccountReason` 的定义注释，不在本处重复。
   *
   * ## ⚠️ 与 minimax 的关键差别：**没有 XFF / 地理分流**
   *
   * AutoClaw 两站各有独立域名（国内 `autoglm-api`、国际 `autoglm-api.autoglm.ai`），
   * **互不 307** ⇒ 本家文案**不得**照抄 minimax 那段「填 X-Forwarded-For」的指引
   * （照抄会让用户去改一个**不生效**的设置）。这句已写进 `unknown` 档的反面：
   * 只说「检查凭据」，不说 XFF。
   *
   * ## 错误码取 `QUOTA_EXCEEDED`
   *
   * 与 buddy / Loomy / minimax 一致：这确实是额度问题，且它**不在**宿主
   * `DEFAULT_RETRYABLE_CODES` 里 ⇒ 不会被白重试（锁定是**确定性**结果）。
   *
   * ⚠️⚠️ **但 `unknown` 档存在一处全仓既有的自相矛盾**（2026-10-21 二轮审计指出，登记不修）：
   *
   * 该档文案写「**请重试**」，而错误码 `QUOTA_EXCEEDED` **不可重试** ⇒ 用户按文案
   * 去重试，宿主不会自动重试、手动重试大概率仍是同一失败。
   *
   * 实测全仓口径（`grep` 六份 `lockedError` 的 `unknown` 档）：
   *
   * | 函数 | 码 | 可重试 | 文案 |
   * |---|---|---|---|
   * | `buddyLockedError` / `qoderLockedError` / `astudioLockedError` / `minimaxLockedError` / **`autoclawLockedError`** | `QUOTA_EXCEEDED` | ❌ | 「请重试」 |
   * | `loomyLockedError` | **`TRANSPORT`** | ✅ | 「请稍后重试」 |
   *
   * ⇒ **五家一致、Loomy 独异**。这不是本次引入的回归（本函数只是跟随了多数派），
   *   而是**既有的一致性缺口**。
   *
   * **为什么不修**：改错误码要碰红线 —— `AUTH` / `QUOTA` 类码在部分客户端会
   * **连 message 一起吞掉**（IKLBSH 复发形态），`QUOTA_EXCEEDED` 是刻意选的
   * （`QUOTA` 会被 harness 换成固定文案）。改文案（去掉「请重试」）又要同步五家
   * + 相关断言，属独立任务。⇒ 登记，不捎带。
   *
   * ⚠️ 两站共用本函数，只换 `displayName`；`displayName` **必须**逐站区分
   * （两站账号不互通，用户要知道去哪个面板解锁）。
   *
   * ## ⚠️ 位置约束（与 astudio 那处同理）
   *
   * 本函数放在 `loomyLockedError` **之前**是有意的：`loomy-balance-error-contract.spec.ts`
   * 用「`const loomyLockedError` 到 `const buddy = new BuddyAuth`」切片来核对 Loomy 的
   * 错误码（Loomy 用可重试的 `TRANSPORT`，本家必须用不可重试的 `QUOTA_EXCEEDED`）。
   * 插进那个区间会让该用例把本家的码当成 Loomy 的核对而**必然变红**。
   */
  const autoclawLockedError = (displayName: string) =>
    (reason: BuddyNoAccountReason): Error => {
      const days = buddyExpiringWindowDays()
      if (reason.kind === 'unknown') {
        return new LlmError(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
          + '的积分 —— 请重试。'
          + `⚠️ 若持续失败，请在 大肥鱼饭碗 的 ${displayName} 面板检查凭据是否失效`
          + '（AutoClaw 的 access_token 是**明文 JWT、寿命恒 24h**，过期后需要重新登录）。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'no-candidates') {
        return new LlmError(
          `${displayName}：没有可用账号。已锁定永久积分，而本次**没有任何候选账号**`
          + '（该 provider 下没有启用中的账号，或全部账号都在本次请求的模型上受限）。'
          + `请在 大肥鱼饭碗 的 ${displayName} 面板确认账号已启用、且未全部处于限流中；`
          + '或改用其它 provider / 模型，或解锁永久积分后重试。',
          'QUOTA_EXCEEDED',
        )
      }
      if (reason.kind === 'credential-only') {
        // ⚠️ **必须与「积分用尽」逐字分开**，且要**明确劝阻解锁**：解锁会不可
        //    撤回地消耗永久积分（流水里那些**不带到期时间**的发放批次），
        //    而本情形的根因在凭据、与积分无关。
        return new LlmError(
          `${displayName}：无法使用任何账号。已锁定永久积分，而余额分档**确实选出了**`
          + '有可用积分的账号 —— 但它们的**凭据读不出来**（凭据缺失 / 已失效 / 被并发续期覆盖）。'
          + '⚠️ 这与「积分用尽」是两件事，**不要去解锁永久积分**（解锁会不可撤回地消耗它们）。'
          + `请在 大肥鱼饭碗 的 ${displayName} 面板检查这些账号的凭据，必要时重新登录。`,
          'QUOTA_EXCEEDED',
        )
      }
      /**
       * ⚠️⚠️ **穷尽性守卫**（与 buddy / Loomy / AStudio / MiniMax 四份同型）：
       * 走到这里**只允许**是 `{ kind: 'exhausted' }`。把 `reason` 赋给单成员类型，
       * 将来 `BuddyNoAccountReason` 加了新档位却忘写文案时，`tsc` 当场报
       * `TS2322`，而不是静默落进「积分都已用尽」—— 那句会把用户推向
       * **不可撤回**的解锁操作。
       */
      const exhaustedOnly: { kind: 'exhausted' } = reason
      void exhaustedOnly
      /**
       * ⚠️⚠️ **本档文案已按「可核实的池名」重写**（2026-10-21 二轮审计，P1 文案失实）。
       *
       * ## 原文案错在哪
       *
       * 初版写「**永久桶**（**「活动赠送」「注册奖励」** 等不带到期时间的批次）」。
       * 审计员逐层考古后确认：**这两个名字没有任何实测来源**，是编的。
       *
       * 事实链：
       * - `parseAutoclawLedgerBatches` 的包名取 `metadata.description > description > source`，
       *   即**上游给什么就是什么**，可能是任意字符串；
       * - 仓库内**唯一**的实测包名样本是「`AutoClaw 用户登录奖励积分，7天有效`」
       *   与「`每日签到`」（`tests/unit/autoclaw-credits.spec.ts` 的 fixture 注明为实测形状）；
       * - 「活动赠送 / 注册奖励」的最早出处是 `autoclaw-credits.ts` 里**描述代码分支**的
       *   一句注释（「无到期字段的发放（活动赠送的永久分）」），随后经
       *   registry 注释 → 审计报告 → 本次提交 → 本函数文案 **五层转述**，
       *   从未有一次报文支撑。
       *
       * ## 用户可见后果（改前）
       *
       * 用户拿着「去找叫『活动赠送』『注册奖励』的分组」去翻钱包流水，
       * **一无所获**（真实名字是「AutoClaw 用户登录奖励积分，7天有效」这类长句）。
       *
       * ## 改法
       *
       * **不再点名任何具体池名**，改为描述**判据本身**（「流水里不带到期时间的发放」）
       * —— 判据是代码里可核实的，池名不是。
       */
      return new LlmError(
        `${displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
        + '积分（AutoClaw 的**带到期时间的发放批次** —— 钱包流水里那些'
        + '带有效期的「每日签到 / 登录奖励」等发放）都已用尽。'
        + '**永久桶**（流水里**不带到期时间**的那些发放）在锁定状态下动不到它们'
        + ' —— 这是锁定的预期效果。'
        + `请在 大肥鱼饭碗 的 ${displayName} 面板解锁永久积分，或等待下一次签到 / 活动发放。`,
        'QUOTA_EXCEEDED',
      )
    }

  /**
   * Loomy 的「锁定永久积分 + 无可用账号」报错文案（issue IKMCOO 缺陷 2/3）。
   *
   * ⚠️ **与 buddy 那份分开**（不是漏抽）：Loomy 的口径是「**今日赠送额度**」
   * （服务端每日刷新的那个池），而 buddy 系是「N 天内到期的资源包」——
   * 两者是不同的业务概念，合并成一句会让用户按错误的判据去排查。
   *
   * ⚠️⚠️ **必须分「全部查不到」与「部分查不到」**（issue IKMCOO 缺陷 2，
   *   2026-10-16）：原实现只有一档 `unknown`，判据是「有任一候选失败」，
   *   于是 **3 个号全查不到**也被报成「**部分**账号的余额查询失败」，
   *   并建议「检查凭据是否失效」—— 而本机实测（4 个账号 `/points/records`
   *   全部 200、字段完整）凭据**全部有效**，照着做完全无效。
   *
   * ⚠️⚠️ **错误码用 `TRANSPORT`，不用自定义码**（issue IKMCOO 缺陷 3，
   *   2026-10-16 实测修正）：原判据里我先写的是新增码 `BALANCE_UNAVAILABLE`，
   *   实读宿主 `@deepseek-ai/dsh-llm/lib/types/retry-policy.js` 的
   *   `DEFAULT_RETRYABLE_CODES` 发现它是
   *   `['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`
   *   —— **自定义码不在其中** ⇒ 宿主照样不重试，缺陷 3 **根本没被修好**
   *   （症状与原来逐字相同：整轮被打断）。
   *   ⇒ 语义最贴近且**确在**默认可重试集合里的是 `TRANSPORT`
   *   （本故障就是「一次取数往返没能完成」），具体分类靠 message 表达。
   *
   * ⚠️ **刻意不用 `AUTH` / `QUOTA`**：那两类在部分客户端会连 message 一起
   *   吞掉（见 AGENTS.md 的 IKLBSH 复发形态），而本故障**需要**用户看到
   *   「换渠道 / 稍后再试」这句指路文案。
   */
  const loomyLockedError = (reason: LoomyNoAccountReason): Error => {
    const details = reason.kind === 'exhausted' ? '' : `（${reason.errors.slice(0, 2).join('；')}）`
    if (reason.kind === 'all-unknown') {
      return new LlmError(
        'Loomy：无法确认是否有可用账号。已锁定永久积分，而**所有**账号的余额查询都失败了'
        + `${details}。这通常是上游限流 / 风控 / 网络中断，**不是**凭据失效 —— `
        + '无需重新登录。可稍后重试，或改用其它 provider / 模型；'
        + '若急于继续，可在 大肥鱼饭碗 的 Loomy 面板**临时解锁永久积分**（会消耗永久积分）。',
        'TRANSPORT',
      )
    }
    if (reason.kind === 'partial') {
      return new LlmError(
        'Loomy：无法确认是否有可用账号。已锁定永久积分，而**部分**账号的余额查询失败'
        + `${details}。其余账号的今日额度已确认用尽；这些账号**可能仍有**今日额度 —— `
        + '请稍后重试，或在 大肥鱼饭碗 的 Loomy 面板核对这些账号的凭据。',
        'TRANSPORT',
      )
    }
    /**
     * ⚠️⚠️ **穷尽性守卫**（与 buddy 那份同型，2026-10-14 审计引入）：
     * 走到这里**只允许**是 `{ kind: 'exhausted' }` —— 它是唯一有事实依据
     * 可以说「今日额度已用尽」的一档（余额分档真的查过，且每个候选的今日
     * 额度确实都是 0）。把 `reason` 赋给单成员类型，将来加了新档位却
     * 忘了写文案时，`tsc` 当场报 `TS2322`，而不是静默落进「已用尽」。
     */
    const exhaustedOnly: { kind: 'exhausted' } = reason
    void exhaustedOnly
    return new Error(
      'Loomy：没有可用账号。已锁定永久积分，而所有账号的今日赠送额度都已用尽。'
      + '请在 大肥鱼饭碗 的 Loomy 面板解锁永久积分，或等待明日额度刷新。',
    )
  }

  const buddy = new BuddyAuth(ctx)
  // buddy 目录的**各来源成败**出参（issue IKJVTF 复审，审计 I3）：
  // `buddy.fetchModels` 每轮原地写入，适配器的 `catalogComplete` 读它。
  // 初值两个 false —— 首轮真正拉取之前没有任何来源可算「取到」。
  buddy.lastCatalogOutcome = { scopedOk: false, configOk: false }
  const buddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(BUDDY_CREDENTIAL_REF),
    resolveCredential: createCredentialResolver<BuddyCredential>(
      // ⚠️ 依赖在**每次 apply() 时**构造一次，闭包捕获的是同一批引用。
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(CODEBUDDY.id, id) } },
      {
        product: CODEBUDDY,
        // 优先按「快到期积分」分档选号（锁定永久积分时也走这条，见上）。
        // provider 实参用 CODEBUDDY 而非字面量 'buddy'：写死字面量在改名/多产品
        // 场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
        readCredential: resolveBuddyCredentialByRef,
        balance: {
          kind: 'buddy',
          selector: buddyBalanceSelector,
          lockedError: buddyLockedError('CodeBuddy'),
          // 免费模型跳过「锁定 + 临期积分」这道门（判据见 BuddyAdapter.isFreeModel）。
          // `buddyAdapter` 在此处是自引用：闭包只在注册完成后才执行，故无 TDZ 问题。
          isFreeModel: (modelId) => buddyAdapter.isFreeModel(modelId),
          // ⚠️ **保留旧闭包的既有不对称**：分档选中时**不**回报账本
          //（buddy 系旧闭包只在池兜底那一支回报）。理由见该字段的说明。
          reportPickedAccount: false,
        },
        fallback: { kind: 'ref', refName: BUDDY_CREDENTIAL_REF },
        // 退到单凭据 ref 之前先证明失败原因：全被模型限流时报明确的限流错误，
        // 而不是让它降级成误导性的 MISSING_CREDENTIAL（见该助手的说明）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    // 刷新**账号池里实际使用的那一个账号**，而不是默认单凭据 ref ——
    // 后者在 大肥鱼饭碗 登录路径下根本不存在，会把 401 报成「未配置凭据」
    // 并自锁。详见 createPoolRefresh 的注释。
    refresh: createPoolRefresh(pool, 'buddy', buddy),
    fetchRemoteModels: () => buddy.fetchModels(pool),
    // ⚠️ 完整性桥接（issue IKJVTF 复审，审计 I3）：buddy 的目录是 scoped +
    // `/v3/config` 的**并集**，两来源 id 集合不同 ⇒ 残缺时只展示、不永久缓存。
    catalogComplete: () => {
      const outcome = buddy.lastCatalogOutcome
      return outcome === undefined ? undefined : isBuddyCatalogComplete(outcome)
    },
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。不可用时适配器自动回退原图。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: CODEBUDDY,
  })

  // ===== WorkBuddy (腾讯 WorkBuddy) 服务 =====
  // 与 CodeBuddy 同源（同后端、同协议），差异全部由 product 配置承载。
  // 服务名由 BuddyAuth 依 product.id 派生，故两个产品分别注册为
  // ctx.buddyAuth / ctx.workbuddyAuth，互不覆盖。
  // 同样不注册斜杠命令：入口在 大肥鱼饭碗 的 WorkBuddy 面板。
  const workbuddy = new BuddyAuth(ctx, { product: WORKBUDDY })
  workbuddy.lastCatalogOutcome = { scopedOk: false, configOk: false }
  const workbuddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(WORKBUDDY.defaultCredentialRef),
    // 只从 workbuddy 的账号池取账号，回退到 WorkBuddy 自己的单凭据 ref，
    // 保证不会串用 CodeBuddy 的凭据。
    // 选号策略与 CodeBuddy 同款，但用的是**WorkBuddy 自己的锁状态与余额缓存**
    // （两站积分构成不同：实测国际版是「Bonus Pack 14 天 + Free Plan 长期」）。
    resolveCredential: createCredentialResolver<BuddyCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(WORKBUDDY.id, id) } },
      {
        product: WORKBUDDY,
        readCredential: resolveBuddyCredentialByRef,
        balance: {
          kind: 'buddy',
          selector: workbuddyBalanceSelector,
          lockedError: buddyLockedError('WorkBuddy'),
          // 免费模型跳过「锁定 + 临期积分」这道门（判据见 BuddyAdapter.isFreeModel）。
          // 用户报障「账户可用却提示没有可用账号」正是缺了这一条：免费模型不扣积分，
          // 却被永久积分锁定拦下。
          isFreeModel: (modelId) => workbuddyAdapter.isFreeModel(modelId),
          // ⚠️ 同 buddy：保留旧闭包「分档选中时不回报账本」的既有不对称。
          reportPickedAccount: false,
        },
        fallback: { kind: 'ref', refName: WORKBUDDY.defaultCredentialRef },
        // 同 buddy：区分「全部限流」与「真的没登录」（见该助手的说明）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    // 同上：必须刷池内账号（`WORKBUDDY_ACCESS_TOKEN` 从未被写入过）。
    // 这条正是「workbuddy + deepseek-v4.1-flash 一直报未配置凭据」的根因。
    refresh: createPoolRefresh(pool, 'workbuddy', workbuddy),
    fetchRemoteModels: () => workbuddy.fetchModels(pool),
    // ⚠️ 完整性桥接（同 buddy，见上）。
    catalogComplete: () => {
      const outcome = workbuddy.lastCatalogOutcome
      return outcome === undefined ? undefined : isBuddyCatalogComplete(outcome)
    },
    readImage: makeReadImage(ctx),
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: WORKBUDDY,
  })

  // ===== LobsterAI (有道龙虾) 服务 =====
  // 第三个产品线，但协议与腾讯系**完全不同**：不走 external-link 轮询登录，
  // 而是本地回调 + authCode 换 token（见 src/lobsterai-oauth.ts）。
  // 服务名由 LobsteraiAuth 依 product.id 派生，注册为 ctx.lobsteraiAuth。
  // 与其他 provider 一样不注册斜杠命令：入口在 大肥鱼饭碗 的 LobsterAI 面板。
  const lobsterai = new LobsteraiAuth(ctx)
  /**
   * 按凭据 ref 解析 LobsterAI 凭据（供选号器查余额与最终取凭据共用）。
   *
   * 抽成局部函数而非内联两遍：选号器需要它查余额，而解析最终凭据又要用它 ——
   * 两处若各写一遍 JSON 解析，格式一变就会只改一处（与 Loomy 那条同因）。
   *
   * ⚠️ **形状校验必须与 `LobsteraiAuth` 的 `parseCredential` 对齐**（理由同
   * TRAE 那份注释：裸 parse 会让损坏凭据一路流到适配器的
   * `credential.access_token.length`，抛不可诊断的 TypeError）。
   */
  const resolveLobsteraiCredentialByRef = async (refName: string): Promise<LobsteraiCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      const parsed = JSON.parse(resolved.value) as LobsteraiCredential
      return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
        ? parsed
        : undefined
    } catch {
      return undefined
    }
  }
  /**
   * LobsterAI 的**按余额优先选号器**（为「锁定永久积分」提供分档依据）。
   *
   * ⚠️ 复用 `BuddyBalanceSelector` 而不是新写一个：分档判据
   * （`splitBuddyCreditsByExpiry`）只读通用的
   * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
   * LobsterAI 的 `fetchLobsteraiCreditBalance` 把 `expiresAt`（ISO 8601）归一化到
   * `deductionEndTime`，故结构一致。
   *
   * ⚠️ **缓存不能跨站共用**（选择器内含按账号 id 的缓存），故每家一个实例。
   *
   * ⚠️ 到期时间缺失的包归入**永久桶**（`splitBuddyCreditsByExpiry` 的保守方向）：
   * LobsterAI 实测所有包都带 `expiresAt`，故这条只在响应异常时生效 ——
   * 那时宁可把它当「不会马上作废」（锁定时少用一个号），
   * 也不要把长期积分误当快到期烧掉。
   */
  const lobsteraiBalanceSelector = new BuddyBalanceSelector({
    product: LOBSTERAI,
    resolveCredential: resolveLobsteraiCredentialByRef,
    fetchBalance: (credential, product) => fetchLobsteraiCreditBalance(credential, product),
  })
  const lobsteraiAdapter = registerLobsteraiLlm(ctx, {
    credentialRef: credentialRef(LOBSTERAI.defaultCredentialRef),
    // 只从 LobsterAI 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用 CodeBuddy / WorkBuddy / CodeArts 的凭据。
    // provider 实参用 LOBSTERAI 而非字面量 'lobsterai'：写死字面量在
    // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    //
    // 优先按「快到期积分」分档选号（锁定永久积分时只挑有快到期积分的号）。
    // 与 buddy 系同一套编排：候选先按「enabled + 模型未受限」筛，
    // 分档只在这批候选内部进行 —— 不能因为某个号积分多就绕开限流标记。
    resolveCredential: createCredentialResolver<LobsteraiCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(LOBSTERAI.id, id) } },
      {
        product: LOBSTERAI,
        // ⚠️ 必须传 LobsterAI 自己的解析器：buddy 系那份对它的凭据结构会解析出
        // 错误形状（见各自 credential 类型）。
        readCredential: resolveLobsteraiCredentialByRef,
        balance: {
          kind: 'buddy',
          selector: lobsteraiBalanceSelector,
          lockedError: buddyLockedError('LobsterAI'),
          // ⚠️ LobsterAI 的「免费」是**钱包**概念不是**模型**概念，没有模型级免费：
          //   `lobsterai-credits.ts:340` 的 `/api/user/quota` 只给
          //   `freeCreditsTotal=300`（免费**积分额度**），`lobsterai-errors.ts`
          //   里的 `freecreditsused` 是**错误码**。模型表本身不带倍率字段
          //   ⇒ 判不出、也不该判（见 `NO_FREE_MODEL` 的说明）。
          isFreeModel: NO_FREE_MODEL,
        },
        fallback: { kind: 'ref', refName: LOBSTERAI.defaultCredentialRef },
        // 退到单凭据 ref 之前先证明失败原因（见 `throwIfAllAccountsRateLimited`
        // 的说明）：全被模型限流时报明确的限流错误，而不是降级成「请先登录」。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `LOBSTERAI_ACCOUNT_XXX` 的凭据，而 `lobsterai.refresh()` 读写的是
      // `LOBSTERAI_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 大肥鱼饭碗 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      //
      // 与 Go 一致：`handler.go:197-209` 也是先 Pick 出账号、再对该账号
      // `RefreshToken(acct)`（而非某个全局单例）。
      const available = await pool.getAvailableAccount(LOBSTERAI.id, '')
      if (available) await lobsterai.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await lobsterai.refresh()
    },
    fetchRemoteModels: () => lobsterai.fetchModels(pool),
    resolveClientVersion: () => lobsterai.resolveClientVersion(),
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 13 张原图（≈50 MiB）
    // 就回 `SERVER code=500`，撞的是请求体体积。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: LOBSTERAI,
  })

  // ===== Qoder (阿里系 AI IDE) 服务 =====
  // 第五个产品线，协议与四者**都不同源**：PKCE 设备码轮询登录
  // （不起本地回调服务器，见 src/qoder-oauth.ts）。
  // 服务名由产品 id 派生，注册为 ctx.qoderAuth。
  // 与其它 provider 一样不注册斜杠命令：入口在 大肥鱼饭碗 的 Qoder 面板。
  const qoder = new QoderAuth(ctx)
  /**
   * 按凭据 ref 解析 Qoder 凭据（供选号器查余额与最终取凭据共用）。
   *
   * ⚠️ **两站共用这一份**（`qoder` / `qodercn` 的凭据形状逐字相同：同一套
   * OAuth 实现，差异只在主机与 ref 前缀）—— 与 minimax 那份同因，
   * 各写一遍 = 改一处漏一处。
   *
   * ⚠️ **逐字保留历史上的裸 `JSON.parse` 形态**（不在此处加形状校验）：
   * 加校验是一次**行为变更**（此前被接受的损坏凭据会变成被拒），
   * 不在本 Task 范围内。历史形态见 git 历史里 qoder / qodercn 两段
   * `readCredential` 里那两份**逐字重复**的内联箭头。
   */
  const resolveQoderCredentialByRef = async (refName: string) => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value)
    } catch {
      return undefined
    }
  }
  /**
   * Qoder 两站的**按「额度何时作废」分档选号器**（为「锁定永久积分」提供依据）。
   *
   * ⚠️ 复用 `BuddyBalanceSelector` 而不是新写一个：分档判据
   * （`splitBuddyCreditsByExpiry`）只读通用的
   * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
   *
   * ⚠️ **两家各建一个实例，不得合并**：选择器内含**按账号 id 的缓存**，
   * 跨站共用会让一站的读数污染另一站（与 minimax 两站同因）。
   *
   * ⚠️⚠️ **必须各传自己的 `product`**：`QODER` 指向 `openapi.qoder.sh`、
   * `QODER_CN` 指向 `openapi.qoder.com.cn` —— 互换的后果**不是报错**而是静默：
   * 对方站点不认本站 token ⇒ 余额恒 `null` ⇒ 未锁定时换号优化失效、
   * 锁定时永远报「没有可用账号」。
   */
  const qoderBalanceSelector = new BuddyBalanceSelector({
    product: QODER,
    resolveCredential: resolveQoderCredentialByRef,
    fetchBalance: (credential, product) => fetchQoderCreditBalance(credential, product),
  })
  const qoderCnBalanceSelector = new BuddyBalanceSelector({
    product: QODER_CN,
    resolveCredential: resolveQoderCredentialByRef,
    fetchBalance: (credential, product) => fetchQoderCreditBalance(credential, product),
  })
  /**
   * 「本次实际使用的账号 id」跟踪表（provider id → 账号 id）。
   *
   * ## 为什么需要它
   *
   * 额度受限时要标记**当前账号**（见 `QoderAdapter.switchAccountOnQuota`）。
   * 但「当前账号」不能靠「再问一次账号池的默认账号」得到 —— 池的选号是
   * `getAvailableAccount()` 的即时决策，与适配器**本次实际拿到**的那份凭据
   * 可能是两个账号（例如池已因限流切走，而适配器手上仍是旧凭据）。
   * 标记落错账号的后果：真正受限的账号没被标记 → 下次又被选中 → 反复撞墙；
   * 无辜账号被标记 → 它当天用不了（虽不致命，但属无谓损失）。
   *
   * 故在 `resolveCredential` 里**记录实际返回的那个账号**，供适配器查询。
   * 用 `Map` 按 provider 分开，国际版与中国版互不影响。
   */
  const activeQoderAccountId = new Map<string, string | undefined>()
  const qoderAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER.defaultCredentialRef),
    // 只从 Qoder 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它 provider 的凭据。
    // provider 实参用 QODER 而非字面量 'qoder'：写死字面量在
    // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    // ⚠️ `modelId` 透传：Qoder 的额度是「模型 + 账号」维度（见
    // `qoder-adapter.ts` 的 `switchAccountOnQuota`），传空串会让它刚写下的
    // 当日额度标记在下次选号时被忽略。
    resolveCredential: createCredentialResolver<QoderCredential>(
      {
        pool,
        // ⚠️ 这里**必须**处理 `undefined`：没有账号条目可标记时要**清空**，否则
        // 留着过期的 id 会让额度标记落在无辜账号上（见 `activeQoderAccountId`）。
        reportAccount: (id) => {
          activeQoderAccountId.set(QODER.id, id)
          if (id !== undefined) reportLedgerAccount(QODER.id, id)
        },
      },
      {
        product: QODER,
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as QoderCredential
          } catch {
            return undefined
          }
        },
        // 优先按「快到期额度」分档选号（锁定永久积分时只挑有快到期额度的号）。
        // ⚠️ `qoderLockedError` **本家独有**（不共用 buddy 系那份）：buddy 的
        //    「临期」指资源包 `DeductionEndTime`，而本家逐包到期时刻拿不到 ——
        //    照抄会让用户按一个不存在的判据去排查（见该函数的长注释）。
        // ⚠️ `reportPickedAccount: true` 是**必须的**（与 minimax 两站同因）：
        //    本家的旧闭包是纯池选号、账本**一直在回报**；接上 `balance` 后
        //    「分档选中」那一支若不回报 ⇒ token 用量记不到本渠道上（静默）。
        balance: {
          kind: 'buddy',
          selector: qoderBalanceSelector,
          lockedError: qoderLockedError('Qoder'),
          reportPickedAccount: true,
          // ⚠️ 免费模型**必须**跳过「锁定 + 临期积分」这道门（与 buddy / trae
          //    同因，见 `credential-resolver.ts:359-365` 的长注释）：
          //    锁定保护的是永久积分，而免费模型既不扣临时也不扣永久积分 ——
          //    不传这个钩子，免费模型会和付费模型走同一条余额分档路，锁定期间
          //    被 `allowPermanent=false` 一并拦下，报出「额度都属于永久」这种
          //    与事实相反的错误（真实报障 2026-10-21）。
          // ⚠️ 判据在适配器里（读远端目录的 `is_free`，远端/兜底同源），
          //    本处只透传 —— 不要在这里另写一份。
          isFreeModel: (modelId) => qoderAdapter.isFreeModel(modelId),
        },
        fallback: { kind: 'ref', refName: QODER.defaultCredentialRef },
        // 区分「全部限流」与「没登录」（见该助手的说明）—— 否则用户会去
        // 重新登录，而凭据其实是好的（真实缺陷，Gitee IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `QODER_ACCOUNT_XXX` 的凭据，而 `qoder.refresh()` 读写的是
      // `QODER_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 大肥鱼饭碗 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      const available = await pool.getAvailableAccount(QODER.id, '')
      if (available) await qoder.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await qoder.refresh()
    },
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 15 张原图（≈57 MiB）
    // 直接 `TRANSPORT: fetch failed`，撞的是请求体体积。
    // ⚠️ qoder 与 qodercn **共用同一个 QoderAdapter 类**，故两站同时受益
    //（与「差异收敛到产品配置」这个模式一致 —— 别以为只改了一站）。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: QODER,
    // 远端模型目录（2026-10-20）：**由 auth 服务取数**，只做池的只读读取。
    // ⚠️ 刻意**不**走 `resolveCredential` —— 它选中账号时会 reportAccount，
    //    而目录请求是周期性的（20 分钟刷新器），会把「本次实际使用的账号」
    //    改写成目录用的账号 ⇒ 额度标记落到无辜账号上（见 `QoderAdapterOptions.fetchRemoteModels`）。
    fetchRemoteModels: () => qoder.fetchModels(pool),
    // 额度受限时标记「本次实际使用的账号」（理由见 `activeQoderAccountId` 注释）。
    currentAccountId: () => activeQoderAccountId.get(QODER.id),
  })

  // ===== Qoder 中国版（qodercn）=====
  // 与上面的国际版是**同一套协议实现**的第二个实例（差异全在 QODER_CN 配置里：
  // 域名 qoder.cn / openapi.qoder.com.cn / gateway.qoder.com.cn、client_id
  // 732aef47-…、以及一张自己的 14 条模型表）。刻意**不复制**任何 qoder*.ts
  // 实现文件 —— 协议同源，复制会让同类缺陷（tools 不下发、工具历史丢
  // tool_calls、错误帧不抛错）修两遍。
  // 服务名由 `${product.id}Auth` 派生，注册为 `ctx.qodercnAuth`（product id
  // `qodercn` 全小写、不带连字符 —— 按变量名驼峰惯例拼会得到大小写不符的名字）。
  // 不注册斜杠命令：入口在 大肥鱼饭碗 的「Qoder (中国版)」面板。
  const qoderCn = new QoderAuth(ctx, { product: QODER_CN })
  const qoderCnAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER_CN.defaultCredentialRef),
    // 只取中国版自己账号池的账号，回退到 QODERCN_ACCESS_TOKEN。
    // ⚠️ provider 实参必须是 QODER_CN：写死 'qoder' 会让中国版
    // 永远查不到自己的账号（本插件在 workbuddy 上踩过同类坑）。
    // ⚠️ `modelId` 透传：与 QODER 同因（当日额度是「模型 + 账号」维度）。
    resolveCredential: createCredentialResolver<QoderCredential>(
      {
        pool,
        // 同国际版：`undefined` 是「清空标记」的有意义事件。
        reportAccount: (id) => {
          activeQoderAccountId.set(QODER_CN.id, id)
          if (id !== undefined) reportLedgerAccount(QODER_CN.id, id)
        },
      },
      {
        product: QODER_CN,
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as QoderCredential
          } catch {
            return undefined
          }
        },
        // 同国际版：分档选号 + 本家独有文案 + 回报实际选中的账号。
        // ⚠️ `displayName` **必须**逐站区分（两站账号不互通，用户要知道去哪个
        //    面板解锁）；`selector` 也必须是中国版自己那一个（缓存不跨站共用）。
        balance: {
          kind: 'buddy',
          selector: qoderCnBalanceSelector,
          lockedError: qoderLockedError('Qoder (中国版)'),
          reportPickedAccount: true,
          // 同国际版：免费模型不受「锁定永久积分」约束（判据在适配器里）。
          isFreeModel: (modelId) => qoderCnAdapter.isFreeModel(modelId),
        },
        fallback: { kind: 'ref', refName: QODER_CN.defaultCredentialRef },
        // 同国际版：区分「全部限流」与「没登录」（见该助手的说明，IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // ⚠️ 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      // 理由与国际版那条真实缺陷完全同因：resolveCredential 优先取池内凭据，
      // 而 refresh() 读写 QODERCN_ACCESS_TOKEN，两者错配会让日志里续期全成功、
      // 用户却「刚登录却一直认证失败」。
      const available = await pool.getAvailableAccount(QODER_CN.id, '')
      if (available) await qoderCn.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await qoderCn.refresh()
    },
    readImage: makeReadImage(ctx),
    // 同 QODER：两站共用同一个适配器类，缩放桥接也必须两边都接
    //（只接一边会让中国版的截图照样撞 57 MiB）。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: QODER_CN,
    // 远端模型目录：同国际版（两站共用同一套实现，差异只在产品配置）。
    fetchRemoteModels: () => qoderCn.fetchModels(pool),
    // 额度受限时用它标记「当前账号」（见 `QoderAdapter.switchAccountOnQuota`）。
    // ⚠️ 取「**本次实际使用**的账号」而非池里默认那一个：池的默认账号可能与之
    // 不同（例如本账号被限流、池已切到别的账号），标错就会让标记落在无辜账号上。
    currentAccountId: () => activeQoderAccountId.get(QODER_CN.id),
  })

  // ===== TRAE（字节 TRAE IDE）服务 =====
  // 第六个产品线，协议与前面几者**完全不同**：认证用 ExchangeToken（轮换 refreshToken），
  // 对话用 Cloud-IDE-JWT 鉴权，载荷需从 OpenAI 格式转换为 SOLO 格式，
  // SSE 为自定义格式（非 OpenAI 标准），需独立解析。
  // 服务名由 TraeAuth 依 product.id 派生，注册为 ctx.traeAuth。
  // 不注册斜杠命令：入口在 大肥鱼饭碗 的 TRAE 面板。
  const trae = new TraeAuth(ctx)
  /**
   * 按凭据 ref 解析 TRAE 凭据（供选号器查余额与最终取凭据共用）。
   * 抽成局部函数而非内联两遍的理由同 buddy / Loomy。
   *
   * ⚠️ **形状校验必须与 `TraeAuth` 的 `parseCredential` 对齐**（不可只 `JSON.parse`）：
   * 裸 parse 会把 `{"foo":1}` 这种损坏凭据**当成有效凭据**返回，随后适配器的
   * `credential.access_token.length` 抛 **TypeError**（而非可诊断的
   * MISSING_CREDENTIAL），且发生在选号之后、不在余额查询的 try/catch 覆盖范围内。
   * 写两遍、强度还不一致 = 改一处漏一处，故此处与 `trae-auth.ts` 保持同一判据。
   */
  const resolveTraeCredentialByRef = async (refName: string): Promise<TraeCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      const parsed = JSON.parse(resolved.value) as TraeCredential
      return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
        ? parsed
        : undefined
    } catch {
      return undefined
    }
  }
  /**
   * TRAE 的**按余额优先选号器**（为「锁定永久积分」提供分档依据）。
   *
   * ⚠️ 同 LobsterAI：复用 `BuddyBalanceSelector`，因为分档判据只读通用的
   * `packages[].{ active, remaining, deductionEndTime }`。TRAE 的
   * `fetchTraeCreditBalance` 把条目级 `expire_time`（秒级 Unix）归一化到
   * `deductionEndTime`，故结构一致。
   *
   * ⚠️ **缓存不能跨站共用**（选择器内含按账号 id 的缓存），故每家一个实例。
   */
  const traeBalanceSelector = new BuddyBalanceSelector({
    product: TRAE,
    resolveCredential: resolveTraeCredentialByRef,
    fetchBalance: (credential, product) => fetchTraeCreditBalance(credential, product),
  })
  const traeAdapter = registerTraeLlm(ctx, {
    credentialRef: credentialRef(TRAE.defaultCredentialRef),
    // 优先按「快到期积分」分档选号（锁定永久积分时只挑有快到期积分的号）。
    // 与 buddy 系同一套编排：候选先按「enabled + 模型未受限」筛，
    // 分档只在这批候选内部进行 —— 不能因为某个号积分多就绕开限流标记。
    resolveCredential: createCredentialResolver<TraeCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(TRAE.id, id) } },
      {
        product: TRAE,
        // ⚠️ 必须传 TRAE 自己的解析器（buddy 系那份对它的凭据结构会解析出
        // 错误形状 —— 它带 uid / machine_id 等字段）。
        readCredential: resolveTraeCredentialByRef,
        balance: {
          kind: 'buddy',
          selector: traeBalanceSelector,
          lockedError: buddyLockedError('TRAE'),
          // 免费模型跳过「锁定 + 临期积分」这道门（判据见 TraeAdapter.isFreeModel）。
          // ⚠️ TRAE 确有 `rate: 0` 的合法免费模型（见 `trae.ts` 的 readConsumptionRate
          // 注释与 `traeDisplayName` 把 0 显示成「免费」），不跳过就会在锁定时被
          // 余额门拦下并报「积分都已用尽」—— 而免费模型根本不扣积分，报错完全误导。
          // `traeAdapter` 在此处是自引用：闭包只在注册完成后才执行，故无 TDZ 问题。
          isFreeModel: (modelId) => traeAdapter.isFreeModel(modelId),
        },
        fallback: { kind: 'ref', refName: TRAE.defaultCredentialRef },
        // 区分「全部限流」与「没登录」（见该助手的说明，IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      const available = await pool.getAvailableAccount(TRAE.id, '')
      if (available) await trae.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await trae.refresh()
    },
    fetchRemoteModels: () => trae.fetchModels(pool),
    // 图片字节桥接：TRAE 上游**支持图片**（见 Issue #IKHDKC 的实测记录），
    // 但模态按模型判定（远端 `display_config.multimodal`），故这里只负责读字节。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: TRAE,
  })

  // ===== Cline（Cline 桌面端 / Cline API）服务 =====
  // 第七个产品线，协议与前面六者**都不同源**：登录是 **WorkOS 设备码轮询**
  // （api.workos.com，不起本地回调端口），鉴权头是 `Bearer workos:<jwt>`
  // （前缀**不可剥**），推理是**标准 OpenAI 兼容**端点。
  // 服务名由 ClineAuth 依 product.id 派生，注册为 ctx.clineAuth。
  // 不注册斜杠命令：入口在 大肥鱼饭碗 的 Cline 面板。
  const cline = new ClineAuth(ctx)
  /**
   * 「本次实际使用的是哪个 Cline **池账号**」——「订阅额度 → 请求记录」的
   * 「账号」列按它归属，面板也是用这个 id 过滤的。
   *
   * ⚠️ 与 `activeQoderAccountId` 同因：必须在 `resolveCredential` 里记录
   * **实际返回的那个账号**，不能事后自己再查一次池 —— 池的选号是即时决策，
   * 与适配器本次拿到的凭据可能已经不是一个账号。
   *
   * ⚠️ 真实缺陷（用户报障「请求记录中数据空白」）：此处曾**完全没有**这个通道，
   * 适配器只好退回记凭据里的 `account_id`（`usr-…`），而面板按池 id
   * （`cline-bb211a53`）过滤 → 两个 id 空间不一致 → 表格永远空白。
   */
  let activeClineAccountId = ''
  const clineAdapter = registerClineLlm(ctx, {
    credentialRef: credentialRef(CLINE.defaultCredentialRef),
    // 只从 Cline 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它 provider 的凭据。
    // provider 实参用 CLINE 而非字面量 'cline'：写死字面量在
    // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
    resolveCredential: createCredentialResolver<ClineCredential>(
      {
        pool,
        // 记录实际选中的池账号（空串 = 回退到单凭据 ref 模式，见适配器注释）。
        // ⚠️ 取不到号时**必须**置空串，否则旧 id 会让「请求记录」的账号列串味。
        reportAccount: (id) => {
          activeClineAccountId = id ?? ''
          // Token 账本（第 2 期）：回报「本笔请求解析出的账号」（空串不回报）。
          if (activeClineAccountId.length > 0) reportLedgerAccount(CLINE.id, activeClineAccountId)
        },
      },
      {
        product: CLINE,
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as ClineCredential
          } catch {
            return undefined
          }
        },
        fallback: { kind: 'ref', refName: CLINE.defaultCredentialRef },
        // ⚠️ 与 buddy / workbuddy 同因（真实缺陷，2026-10-03 用户报障）：
        // 唯一的 cline 账号被**模型级限流**标记挡住时，候选会筛成空集，最终降级成
        // `cline: no usable credential; log in first` —— 凭据明明在、账号也登录着，
        // 用户却被指去重新登录，方向完全错。故必须在退到单凭据 ref **之前**
        // 先把「其实是限流，预计 X 后解禁」说清楚。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `CLINE_ACCOUNT_XXX` 的凭据，而 `cline.refresh()` 读写的是
      // `CLINE_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 大肥鱼饭碗 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      const available = await pool.getAvailableAccount(CLINE.id, '')
      if (available) await cline.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await cline.refresh()
    },
    // 图片字节桥接：Cline 内嵌目录的 `capabilities` 含 `images`，
    // 模态按模型判定（见 ClineAdapter.inputModalitiesFor）。
    readImage: makeReadImage(ctx),
    // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 24 张原图全过、
    // 32 张（≈122 MiB）才 `TRANSPORT` —— 余量比其他家大，但仍需兜住长会话。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    // 「请求记录」的账号归属（见上面的 `activeClineAccountId`）。
    currentAccountId: () => activeClineAccountId.length > 0 ? activeClineAccountId : undefined,
    product: CLINE,
  })

  // ===== Loomy（讯飞办公助手）服务 =====
  // 第八个产品线，与前面七者**都不同源**：登录是**短信验证码**
  // （讯飞 CAccount，HMAC-SHA1 签名，没有 loginUrl 可打开），
  // 推理是标准 OpenAI 兼容（复用 openai-compat.ts）。
  // 服务名由 LoomyAuth 依 product.id 派生，注册为 ctx.loomyAuth。
  // 不注册斜杠命令：入口在 大肥鱼饭碗 的 Loomy 面板。
  const loomy = new LoomyAuth(ctx)

  /**
   * 按凭据 ref 解析 Loomy 凭据（供选号器与兜底路径共用）。
   *
   * 抽成局部函数而非内联两遍：选号器需要它查余额，而解析最终凭据又要用它 ——
   * 两处若各写一遍 JSON 解析，格式一变就会只改一处。
   */
  const resolveLoomyCredentialByRef = async (refName: string): Promise<LoomyCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as LoomyCredential
    } catch {
      return undefined
    }
  }

  /**
   * 把共享读数里的 `CreditBalance` 拆成 loomy 选号要的两个数。
   *
   * ⚠️⚠️ **按包名映射，只此一处**：`provider-credits.ts` 的 `makePackage` 写的
   *   包名是「永久积分」/「每日赠送」，共享缓存里存的就是那个形状。
   *   ⚠️ **判据用 `includes` 而非 `===`**：包名带「（陈旧）」之类后缀时
   *   仍要认得出来 —— 用等值会在文案微调后静默变成「读不到余额」，
   *   那正是本 issue 的症状形态。
   * ⚠️ 两池都认不出时返回 `{}`（**不编造 0**）：上层据此判「没有可用读数」。
   */
  const loomyPoolsOf = (balance: CreditBalance): { daily?: number; permanent?: number } => {
    let daily: number | undefined
    let permanent: number | undefined
    for (const pkg of balance.packages ?? []) {
      if (pkg.name.includes('每日')) daily = pkg.remaining
      else if (pkg.name.includes('永久')) permanent = pkg.remaining
    }
    return {
      ...daily === undefined ? {} : { daily },
      ...permanent === undefined ? {} : { permanent },
    }
  }

  /**
   * 按账号池 id 取一份已解析的 loomy 凭据（共享读数的槽需要它）。
   *
   * ⚠️ 读不到（账号已删 / 凭据损坏）返回 `undefined` ⇒ 缓存记成失败读数 ⇒
   *   选号器照常回落自己取数（并得到它自己的「凭据未配置或已失效」结论）。
   */
  const readLoomyCredentialFor = async (accountId: string): Promise<LoomyCredential | undefined> => {
    const entry = pool.listAccountsByProvider(LOOMY.id).find((a) => a.id === accountId)
    if (entry === undefined) return undefined
    return await resolveLoomyCredentialByRef(entry.credentialRef)
  }

  /**
   * Loomy 的**按余额优先选号器**（负载均衡）。
   *
   * ⚠️ **为什么需要它**（真实缺陷）：实测 Loomy 的今日赠送额度（每天 5000）
   * 耗尽后，服务端**继续扣永久积分且不报错** —— 「耗尽」是**静默降级**而非错误。
   * 而本插件既有的「限流 → 换号」只在服务端返回限流错误时触发，
   * 故对 Loomy **完全无效**：会一直烧同一个号（用户报障）。
   *
   * 策略：优先有今日额度的号 → 其次有永久积分的号 → 都无/查不到排最后。
   * 档内保持手动拖拽顺序（详见 `loomy-balance-rank.ts`）。
   */
  const loomyBalanceSelector = new LoomyBalanceSelector({
    product: LOOMY,
    resolveCredential: resolveLoomyCredentialByRef,
    /**
     * ★ 吃**共享余额读数**（2026-10-16，issue IKMCOO 缺陷 1）。
     *
     * ## 为什么必须接（用户报障的核心矛盾）
     *
     * 「面板显示三个账号都有余额，但对话一直报『余额查询失败』」—— 两条路径
     * 各发各的请求、各存各的缓存，于是**可以同时成立且互相矛盾**。
     * ⇒ 这里让选号与面板**看同一份读数**，矛盾从根上消失。
     *
     * ⚠️ **`LOOMY_CREDIT_DETAIL` 从共享读数里取**：`CreditBalance` 有两池
     *   （`packages`），而选号器要的是 `permanent` / `daily` 两个数 ——
     *   由**包名**映射（`provider-credits.ts` 造包时写的就是「永久积分」/
     *   「每日赠送」）。⚠️ 这层映射**只此一处**，不得在别处再写一份。
     *
     * ⚠️ **陈旧读数按成功处理**：兼顶值确实可用（`ok: true`），只是标了
     *   `error` 让 UI 能显示数据时间。标成失败会把「有今日额度的号」踢出候选 ——
     *   那正是本 issue 的症状。
     *
     * ⚠️ 共享缓存**未注册**时返回 `undefined` ⇒ 选号器照常自己取数（逐字节同旧）。
     */
    sharedReading: async (accountId) => {
      const reading = await balanceCache.readStale(LOOMY.id, accountId, {
        credential: await readLoomyCredentialFor(accountId),
      })
      if (reading.value === undefined) return undefined
      return {
        ...loomyPoolsOf(reading.value as CreditBalance),
        stale: reading.stale,
        at: reading.at,
        ...reading.error === undefined ? {} : { error: reading.error },
      }
    },
  })

  const loomyAdapter = registerLoomyLlm(ctx, {
    credentialRef: credentialRef(LOOMY.defaultCredentialRef),
    /**
     * 解析本轮该用哪个账号的凭据。
     *
     * ⚠️ `modelId` 由适配器传入（见 `LoomyAdapterOptions.resolveCredential`
     * 的签名说明）—— **必须透传给选号**，否则模型级限流过滤失效
     *（早期实现传空串 `''`，等于「不按模型过滤」）。
     *
     * ⚠️ **loomy 走自己的分档分支，不并入 buddy 那套 `pickBuddyAccount`**：
     * 它的 reason 类型（`LoomyNoAccountReason`）与余额语义（`dailyBalance`
     * 今日赠送额度 vs buddy 系的「N 天内到期的资源包」）都不同，且旧闭包里
     * **没有池取号那一步** —— 强行合并会同时引入「凭据坏了就换号」与「回落池」
     * 两个行为变更。设计边界是**抽象编排，不抽象协议**。
     */
    resolveCredential: createCredentialResolver<LoomyCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(LOOMY.id, id) } },
      {
        product: LOOMY,
        // 复用上面的解析器而不是再写一遍 JSON.parse：两处各写一遍时，
        // 形状校验的强度会分叉（这正是 TRAE 那份注释记的坑）。
        readCredential: resolveLoomyCredentialByRef,
        balance: {
          kind: 'loomy',
          selector: loomyBalanceSelector,
          lockedError: loomyLockedError,
        },
        fallback: { kind: 'ref', refName: LOOMY.defaultCredentialRef },
        // ⚠️ 先证明失败原因是不是限流（见该助手的说明，IKJOZ9）：唯一启用账号
        // 被该模型限流时，候选在筛选里已被筛空 —— 那不是「没登录」。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async (forCredential) => {
      // ⚠️ Loomy **没有 refresh 端点**，这里的 `refresh` 语义是
      // 「探测凭据是否仍有效」，失效时抛错提示重新登录。
      //
      // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则探测的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      //
      // ⚠️⚠️ **优先探测调用方指定的那一份凭据**（2026-10-20 审计 E-2）。
      //
      // 适配器在热路径上用它裁决「**本轮要用的那份**凭据还能不能用」，
      // 而这里原先恒探测 `pool.getAvailableAccount(LOOMY.id, '')` = **池默认号**
      // ⇒ 二者可能不是同一个号 ⇒ **另一个号的终态会打死本轮**
      //（实测：本轮号完全可用，仍整轮失败、业务请求 0 次）。
      //
      // ⚠️ 反查失败时**退回原行为**（探测默认号）而不是跳过探测：
      //    「宁可退化成旧行为，也不要凭空少做一次健康检查」。
      const target = forCredential === undefined
        ? undefined
        : await pool.findAccountIdByCredential(LOOMY.id, forCredential.access_token).catch(() => undefined)
      // ⚠️ 从池里取**该账号自己的** `credentialRef`，不自己拼 `LOOMY_ACCOUNT_` 前缀
      //    —— 前缀是记账格式，拼错会静默探测到另一份/不存在的凭据。
      const targetEntry = target === undefined || target.length === 0
        ? undefined
        : pool.listAccountsByProvider(LOOMY.id).find((entry) => entry.id === target)
      if (targetEntry !== undefined) {
        await loomy.refreshAccountCredential(targetEntry.credentialRef, pool, targetEntry.id)
        return
      }
      const available = await pool.getAvailableAccount(LOOMY.id, '')
      if (available) await loomy.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await loomy.refresh()
    },
    // ⚠️ 必须注入：适配器在热路径上把「非终态探测失败」降级为告警而不是抛错，
    // 没有这个出口就等于静默（本仓库反复记录过的失败形态）。
    warn: (message) => ctx.logger?.warn?.(message),
    // 远端模型目录：GET /api/v1/models。
    // ⚠️ 必须用 **token 头**（业务端点），不是 Bearer —— 带错会得到
    // `100002 缺少 token`，表现为「模型列表永远停在兜底表」。
    // 失败时返回空数组，由适配器回退兜底表。
    fetchRemoteModels: async () => {
      const available = await pool.getAvailableAccount(LOOMY.id, '')
      const resolved = available !== null && available !== undefined
        ? { value: JSON.stringify(available.credential) }
        : await ctx.credentials.resolve(credentialRef(LOOMY.defaultCredentialRef))
      if (resolved === undefined) return []
      let credential: LoomyCredential
      try {
        credential = JSON.parse(resolved.value) as LoomyCredential
      } catch {
        return []
      }
      const response = await fetch(`${LOOMY.apiBase}/models`, {
        headers: { Accept: 'application/json', token: credential.access_token },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) return []
      return parseLoomyRemoteModels(await response.json())
    },
    // 图片字节桥接：按模型能力判定（远端 capabilities.input_modalities 含 image）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: LOOMY,
  })

  // ===== Raccoon Work（商汤小浣熊）服务 =====
  // 第九个产品线。登录与 Loomy 同型（**本地页承载**的微信扫码 + 短信双路径），
  // 但**有** refresh 端点（凭据可静默续期），且客户端可能未安装。
  //
  // ⚠️ **不依赖客户端**：官方桌面端靠 `office-raccoon://auth/callback` 自定义协议
  // 回调，本插件（宿主侧 Node 进程）收不到；故改为「宿主本地生成 code + 自行轮询」，
  // 完全绕开该回调。凭据存插件自有的 ctx.credentials，不读客户端任何文件。
  // 见 tests/unit/raccoon-client-independence.spec.ts 的回归防线。
  //
  // 服务名由 RaccoonAuth 依 product.id 派生，注册为 ctx.raccoonAuth。
  // 不注册斜杠命令：入口在 大肥鱼饭碗 的 Raccoon 面板。
  const raccoon = new RaccoonAuth(ctx)
  const raccoonAdapter = registerRaccoonLlm(ctx, {
    credentialRef: credentialRef(RACCOON.defaultCredentialRef),
    // 只从 raccoon 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它 provider 的凭据。
    // provider 实参用 RACCOON 而非字面量：写死字面量在改名/多产品场景下
    // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    // ⚠️ `modelId` 透传：否则模型级限流标记被忽略（详见 buddy 处说明）。
    resolveCredential: createCredentialResolver<RaccoonCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(RACCOON.id, id) } },
      {
        product: RACCOON,
        // ⚠️ raccoon 的兜底是**裸 `JSON.parse`**（历史形态，本 Task 逐字保留）。
        // 它此前也没有形状校验，本 Task 的约束是零行为变更 ⇒ 不在此处加严。
        readCredential: async (refName) => {
          const resolved = await ctx.credentials.resolve(credentialRef(refName))
          if (!resolved) return undefined
          try {
            // `getAvailableAccount` 的凭据类型是 `CodeArtsCredential | BuddyCredential`
            // 联合（历史遗留），与 `RaccoonCredential` 无充分重叠，故经 `unknown` 转换。
            return JSON.parse(resolved.value) as unknown as RaccoonCredential
          } catch {
            return undefined
          }
        },
        fallback: { kind: 'ref', refName: RACCOON.defaultCredentialRef },
        // 区分「全部限流」与「没登录」（见该助手的说明，IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // ⚠️ raccoon **有** refresh 端点（与 Loomy 恒 false 不同），这里是真续期。
      //
      // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      const available = await pool.getAvailableAccount(RACCOON.id, '')
      if (available) {
        // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回
        // 账号池，否则 UI 会一直显示「已过期」而实际能正常发消息
        //（真实缺陷：JWT 已续到 15:09、账号池仍是 12:02，相差 3.1 小时）。
        // 这条路径正是「发消息时按需续期」，故它是最常触发回写的地方。
        await raccoon.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await raccoon.refresh()
      }
    },
    // 远端模型目录：委托给 RaccoonAuth.fetchModels（它负责 Bearer 头与
    // visible 过滤 + raccoonDisplayName 生成含倍率的展示名）。
    // 失败时返回空数组，由适配器回退兜底表。
    fetchRemoteModels: () => raccoon.fetchModels(pool),
    // 图片字节桥接：按模型能力判定（远端 tags 含 vision）。
    readImage: makeReadImage(ctx),
    // ⚠️ raccoon 尤其需要请求版本：该网关按**请求体字节**设限
    // （实测 `HTTP_413: request body exceeds 10MB`，两张大截图就占掉大半配额）。
    readImageRequest: makeReadImageRequest(ctx),
    accountPool: pool,
    product: RACCOON,
  })

  // ===== MiniMax Code（中国版）服务 =====
  //
  // ⚠️ 登录走 **OAuth 设备码 + PKCE**（与 Qoder 同型：不起本地监听端口，
  // `startLogin` 立即返回 `verification_uri_complete`，后台轮询换 token）。
  // 但协议族与其余九个都不同 —— 它是**首个 Anthropic Messages 协议族**的 provider。
  //
  // ⚠️ **本轮不实现推理**：账号余额不足（`insufficient_balance_error`），无法端到端
  // 验证。适配器的 `stream()` 抛明确错误（**不静默返回空流** —— 静默会让 UI 表现为
  // 「干净地停止、无任何报错」，是 Qoder 早期的同型缺陷）。
  // 故**不传** `readImage` / `readImageRequest`（图片只在推理时有意义）。
  //
  // 服务名由 MinimaxAuth 依 product.id 派生，注册为 ctx.minimaxAuth。
  // 不注册斜杠命令：入口在 大肥鱼饭碗 的 MiniMax 面板。
  /**
   * 按凭据 ref 解析 MiniMax 凭据（**两个产品共用**）。
   *
   * ⚠️ 拆成具名函数（原先是两处内联的匿名箭头，逐字重复）：选号器的
   * `resolveCredential` 与注册项的 `readCredential` 必须是**同一个**解析器 ——
   * 写两份、强度不一致 = 改一处漏一处（本仓库在 LobsterAI / TRAE / AStudio
   * 三处都踩过这个形态）。
   *
   * ⚠️ **保持裸 `JSON.parse` 的历史形态，不在此处加形状校验**：那会是行为变更
   * （与 raccoon / gemini 同款）；本函数只做「抽出来共用」这一件事。
   */
  const resolveMinimaxCredentialByRef = async (
    refName: string,
  ): Promise<MinimaxCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as unknown as MinimaxCredential
    } catch {
      return undefined
    }
  }
  /**
   * MiniMax 两站的**按「积分何时作废」分档选号器**（为「锁定永久积分」提供依据）。
   *
   * ⚠️ 复用 `BuddyBalanceSelector` 而不是新写一个：分档判据
   * （`splitBuddyCreditsByExpiry`）只读通用的
   * `packages[].{ active, remaining, deductionEndTime }`，**与 provider 无关**。
   * `fetchMinimaxCreditBalanceDetailed` 自 2026-10-20 起把每条明细的
   * `expire_at_ms`（毫秒时间戳，实测无需 ×1000）归一化到 `deductionEndTime`。
   *
   * ⚠️ **两站各一个实例**：选择器内含按账号 id 的余额缓存，共用会串味
   *（两站账号不互通、主机也不同）。
   *
   * ⚠️⚠️ **国际站必须透传 XFF**（与 `creditsTable` / `expiryTable` 那两处同因）：
   * `agent.minimax.io` 按出口 IP 把大陆来源 307 到中国站，而中国站不认国际站
   * token ⇒ 折算恒失败 ⇒ 该渠道在聚合轮换里被**静默**剔除（面板却还能刷新，
   * 因为那走的是另一条带了 XFF 的链路）。`pool.minimaxXff()` **每次现读**，
   * 不固化成字符串 —— 用户随时可能改设置。
   */
  const minimaxBalanceSelector = new BuddyBalanceSelector({
    product: MINIMAX,
    resolveCredential: resolveMinimaxCredentialByRef,
    fetchBalance: (credential, product) => fetchMinimaxCreditBalance(credential, fetch, product),
  })
  const minimaxIntlBalanceSelector = new BuddyBalanceSelector({
    product: MINIMAX_INTL,
    resolveCredential: resolveMinimaxCredentialByRef,
    // ⚠️ `fetchFor`：余额端点也在 `agent.minimax.io` 上 ⇒ 大陆出口恒 307
    //    ⇒ 折算恒失败 ⇒ 该渠道在聚合轮换里被**静默剔除**（面板却还能刷新，
    //    因为那走的是另一条带了 XFF 的链路）。
    fetchFor: minimaxIntlFetchForAccount,
    fetchBalance: (credential, product, ctx) =>
      fetchMinimaxCreditBalance(
        credential,
        ctx?.fetchFor?.(ctx.accountId ?? '') ?? fetch,
        product,
        pool.minimaxXff(),
      ),
  })
  const minimax = new MinimaxAuth(ctx)
  const minimaxAdapter = registerMinimaxLlm(ctx, {
    credentialRef: credentialRef(MINIMAX.defaultCredentialRef),
    // provider 实参用 MINIMAX 而非字面量：写死字面量在改名/多产品场景下
    // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    // ⚠️ 只从 minimax 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它 provider 的凭据。
    resolveCredential: createCredentialResolver<MinimaxCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(MINIMAX.id, id) } },
      {
        product: MINIMAX,
        // ⚠️ 与选号器**共用同一个**解析器（原先这里是一份内联的匿名箭头，
        //    与下面 MINIMAX_INTL 那份逐字重复 ⇒ 改一处漏一处；已抽成
        //    `resolveMinimaxCredentialByRef`）。历史形态是**裸 `JSON.parse`**，
        //    逐字保留，不在此处加形状校验（那会是行为变更）。
        readCredential: resolveMinimaxCredentialByRef,
        /**
         * ⚠️ **2026-10-20 新增**（用户报障：「MiniMax Code 积分也有到期时间，
         * 也应当有相同功能」）。
         *
         * 此前本家**不传 `balance`** ⇒ 走 `getAvailableAccount` 的「手动序第一个
         * 启用账号」，**与到期时间无关** ⇒ 既没有「临期优先」，也没有任何东西
         * 可供「锁定永久积分」判断 ⇒ 锁上了也不知道该不该拦。
         *
         * ⚠️ 本家**没有**免费模型概念（`MinimaxAdapter` 不实现 `isFreeModel`），
         * 故不传该字段 —— 缺省 `undefined` 走常规分档路径（正确行为）。
         */
        balance: {
          kind: 'buddy',
          selector: minimaxBalanceSelector,
          lockedError: minimaxLockedError('MiniMax Code (中国版)'),
          // ⚠️ 本家没有模型级免费概念（产品表零 `isFree` 字段，上游目录也不返回）。
          isFreeModel: NO_FREE_MODEL,
          /**
           * ⚠️⚠️ **刻意不写 `reportPickedAccount: false`**（与 buddy 系那两处**相反**）。
           *
           * `reportPickedAccount: false` 是**buddy 系旧闭包的历史不对称**
           *（它们只在池兜底那一支回报），本 Task 逐字保留。而 MiniMax 的旧闭包
           * 是**纯池选号**（本就无余额分档）⇒ 它的账本**一直在回报**。
           * 若照抄 buddy 写 `false`，本节新增的 `balance` 会让「分档选中」那支
           * 不再回报 ⇒ **账本归属静默丢失**（token 用量记不到这个渠道上）。
           * 该形态由 `tests/unit/credential-resolver.spec.ts` 的
           * 「<provider>：池命中时回报 token 账本」逐家驱动 `apply()` 守着 ——
           * minimax / minimaxintl 正在那份名单里（它们此前**可达**）。
           */
          reportPickedAccount: true,
        },
        fallback: { kind: 'ref', refName: MINIMAX.defaultCredentialRef },
        // 区分「全部限流」与「没登录」（见该助手的说明，IKJOZ9）。
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // ⚠️ MiniMax **有** refresh 端点（`/oauth2/token` 的 refresh_token 授权），
      // 这里是真续期（与 Loomy 的「只能探测有效性」不同）。
      //
      // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      const available = await pool.getAvailableAccount(MINIMAX.id, '')
      if (available) {
        // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回
        // 账号池，否则 UI 会一直显示「已过期」而实际能正常发消息
        //（真实缺陷：JWT 已续到 15:09、账号池仍是 12:02，相差 3.1 小时）。
        //
        // ⚠️ `getAvailableAccount` 返回 **`{ entry, credential }`** 两层 ——
        // 账号 id 与 credentialRef 在 **`available.entry`** 里，**不是**
        // `available.id` / `available.credentialRef`（那是 `undefined`，
        // 会让续期**静默写不回账号池**）。
        await minimax.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await minimax.refresh()
      }
    },
    // 远端模型目录：委托给 MinimaxAuth.fetchModels（它负责 Bearer 头 + 信封解析）。
    // ⚠️ **必须走远端** —— 客户端内置静态表只有 3 个模型，远端下发 4 个，
    // 照抄内置表会漏掉 `MiniMax-M3.1-Flash-Preview`（用户截图里选中的那个）。
    // 失败时返回兜底表（适配器侧也有兜底）。
    fetchRemoteModels: () => minimax.fetchRemoteModelsOnly(pool),
    // 图片字节桥接：模态按模型判定（远端 `modalities.input` 含 image，
    // 只有 M3.1-Flash-Preview 与 M3 是）。适配器声明不支持时会**报错**，
    // 不会把图片发出去让服务端 400。
    // ⚠️ 实测 MiniMax 收 **裸 base64** 的 Anthropic `image.source.base64`
    // （OpenAI 的 `image_url` 形状被服务端明确拒绝）。
    // ⚠️ 暂**不接** `readImageRequest` 缩放桥接：MiniMax 的单图上限是
    // 10 MiB（远端 `capabilities.max_image_bytes_inline`），未实测过超限行为，
    // 不凭猜测加一层（Qoder/Raccoon 是**实测撞了体积限制**才接的）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: MINIMAX,
  })

  // ===== MiniMax Code 国际版（minimaxintl）=====
  //
  // 与中国版是**同一套协议实现**的第二个实例（差异全在 `MINIMAX_INTL` 配置里：
  // 主机 `account.minimax.io` / `agent.minimax.io`、目录 region `en`、
  // 凭据 ref 前缀 `MINIMAXINTL_`）。刻意**不复制**任何 `src/minimax*.ts`
  // 实现文件 —— 协议同源，复制会让同类缺陷（SSE 收尾丢帧、换号记账、
  // 思考档位）修两遍。
  //
  // 服务名由 `${product.id}Auth` 派生，注册为 `ctx.minimaxintlAuth`
  //（product id 全小写、不带连字符 —— 按变量名驼峰惯例拼会得到大小写不符的名字）。
  //
  // ⚠️ **两站账号不互通、API 主机也不同** ⇒ 它们是两个 provider 而不是
  //    「一个 provider 加一个站点参数」（理由见 `src/minimax-product.ts` 文件头）。
  // ⚠️ **验证状态如实标注**（2026-10-16 合并审计修正 —— 原文写「三项未真机验证」，
  //    已被本 PR 后续的真机取证推翻，见 `src/minimax-product.ts` 文件头的实测表）：
  //    推理路径与签到端点形状**已真机验证通过**（2026-10-15，真实国际站账号，
  //    推理 200 + 真实 SSE、签到/积分 200）；**只有兜底模型表**未按国际站远端采集
  //   （它与国内站共用同一份，只在远端失败时兜底）。
  //
  // ⚠️ **国际站是唯一需要「按账号换出口」的那一站**：`agent.minimax.io` 按出口
  //    IP 国别分流，大陆来源恒 307 到中国站 ⇒ 与「凭据失效」同形的 401。
  //    ⇒ 登录 / 续期 / 目录 / 身份 / 推理 / 积分**六条链路**都要走
  //    `minimaxIntlFetchForAccount`（中国站**刻意不注入**：它直连才是最优，
  //    出海反而更慢且可能被引导到国际站）。
  const minimaxIntl = new MinimaxAuth(ctx, {
    product: MINIMAX_INTL,
    fetchFor: minimaxIntlFetchForAccount,
  })
  const minimaxIntlAdapter = registerMinimaxLlm(ctx, {
    credentialRef: credentialRef(MINIMAX_INTL.defaultCredentialRef),
    // ⚠️ provider 实参必须是 MINIMAX_INTL：写死 MINIMAX 会让国际站永远查不到
    // 自己的账号（本插件在 workbuddy 上踩过同类坑）。
    resolveCredential: createCredentialResolver<MinimaxCredential>(
      { pool, reportAccount: (id) => { if (id !== undefined) reportLedgerAccount(MINIMAX_INTL.id, id) } },
      {
        product: MINIMAX_INTL,
        // ⚠️ 与中国版**共用同一个**解析器（见 `resolveMinimaxCredentialByRef` 的说明）。
        //    两站凭据形状逐字相同（同一套 OAuth 实现，只换主机与 ref 前缀）。
        readCredential: resolveMinimaxCredentialByRef,
        // ⚠️ 与中国版**同因同日**新增（2026-10-20）：两站共用同一个
        //    `fetchMinimaxCreditBalanceDetailed`。
        //    ⚠️⚠️ 但**选号器必须是国际站那一个实例** —— 它透传 `pool.minimaxXff()`
        //    （绕地理分流，issue IKMEVG）；误用国内站实例会让国际站余额查询
        //    恒失败 ⇒ 该渠道在聚合轮换里被静默剔除。
        balance: {
          kind: 'buddy',
          selector: minimaxIntlBalanceSelector,
          lockedError: minimaxLockedError('MiniMax Code (国际版)'),
          // ⚠️ 本家没有模型级免费概念（产品表零 `isFree` 字段，上游目录也不返回）。
          isFreeModel: NO_FREE_MODEL,
          // ⚠️ 与中国版**同因**：本家旧闭包是纯池选号、账本一直在回报 ⇒
          //    必须 `true`，写 `false` 会让 token 用量记不到国际站上（见中国版处说明）。
          reportPickedAccount: true,
        },
        fallback: { kind: 'ref', refName: MINIMAX_INTL.defaultCredentialRef },
        throwIfAllRateLimited: throwIfAllAccountsRateLimited,
      },
    ),
    refresh: async () => {
      // 同中国版：刷新**解析凭据时所用的那一个**账号，不是默认单凭据 ref。
      const available = await pool.getAvailableAccount(MINIMAX_INTL.id, '')
      if (available) {
        // ⚠️ **必须传 pool + entry.id**（两层结构）：否则续期成功后新 `expiresAt`
        // 写不回账号池，UI 会一直显示「已过期」而实际能正常发消息。
        await minimaxIntl.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await minimaxIntl.refresh()
      }
    },
    fetchRemoteModels: () => minimaxIntl.fetchRemoteModelsOnly(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    // ⚠️ **推理主路径必须走该账号的出口**（国际站代理）。适配器会在换号后
    // 按 `activeAccountId` **每次现取**，故传的是**解析器**而不是一份 fetcher。
    fetchFor: minimaxIntlFetchForAccount,
    product: MINIMAX_INTL,
  })

  // ===== Gemini（Google Cloud Code Assist 免费线）=====
  //
  // ⚠️ **只做 OAuth**（用户拍板）：API key / AI Studio 两条线不做 —— 免费线
  // 是 Cloud Code 项目制，凭据就是 Google OAuth 的 access_token + refresh_token。
  //
  // 与其余 provider 的四处**形态差异**（全部来自 `docs/GEMINI-PORT-PLAN.md`
  // §2.2 的抓包实测，**不许"顺手统一"**）：
  //   1. 请求走**双层信封**（`{model, project, request:{contents,…}}`），且
  //      **必须逐层字母序序列化** —— 上游对字段顺序敏感，原版靠 Go 的 map
  //      键自动排序实现；TS 的 `JSON.stringify` 按插入序，故走
  //      `marshalAlphabetical`（见 `gemini.ts`）。
  //   2. 五个身份头**逐字写死**（`geminiHeaders`），且流式请求**刻意不带
  //      `Accept`**（与抓包一致）。
  //   3. `thoughtSignature` 是**跨轮状态**：`functionCall` 上的签名要落盘、
  //      下一轮按「工具名 + 规范化参数」回填，否则多轮工具调用必被上游拒。
  //      故这里建一个独立的 `gemini-sigs.json` 缓存（**不放 state.json** ——
  //      那是整体替换语义，会被别的写入覆盖掉）。
  //   4. 模型暴露 1 个 `gemini-3.8-flash` + 4 档 efforts（低/中/高/自适应）；
  //      **不**暴露带后缀的模型名，也**不**暴露 lite（上游恒 404，用户
  //      2026-10-03 拍板移除）。
  //
  // 服务名由 GeminiAuth 依 product.id 派生，注册为 ctx.geminiAuth。
  // 不注册斜杠命令：入口在 大肥鱼饭碗 的 Gemini 面板。
  //
  // ⚠️ Gitee issue IKLTZ2：Gemini 全部端点都在墙外，而 undici 既不读 Windows
  // 系统代理、也不读 `HTTP(S)_PROXY` ⇒ 「浏览器授权成功、面板里账号一直不出现」。
  // 这里接上**按账号取 fetcher** 的解析器（与 `probeById` 共用同一份）。
  // ⚠️ 与 Gemini 同款：池子在 `apply()` 里才就绪，而 `probeById` 是模块级常量
  //    （可能在 `apply()` 之前就被求值）⇒ 走可变引用，未注入时恒直连。
  //
  // ⚠️ 一次注入同时喂**两条腿**（PR !145 审计 P1 修法）：
  //    ① 按账号取出口（`minimaxIntlFetchForAccount`）；
  //    ② 探测槽的 XFF（`minimaxIntlXffForProbe`）。
  //    初版给 ② 另开了 `globalThis.__jetHubMinimaxXffPool`，两套机制、且 dispose
  //    后不清理。现在两者共用 `minimaxPoolRef` —— **传 `undefined` 即可整体重置**
  //    （插件卸载路径若将来需要，直接调 `setMinimaxProxyPool(undefined)`）。
  setMinimaxProxyPool(pool)
  setGeminiProxyPool(pool)
  return {
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
  }
}

/**
 * 「该产品的账号全部限流」闸门（region 里以 `const` 箭头函数形态声明，
 * 函数作用域内 ⇒ 模块级 `typeof` 看不见它，故此处显式写出签名）。
 */
export type AllLimitedGuard = (product: { id: string; displayName: string }, modelId?: string) => void

/**
 * 「已锁定永久积分、但没有可用账号」的错误构造器：先绑定产品显示名，
 * 再由选择器的 `reason` 生成人话报错。astudio / autoclaw 两家同型。
 */
export type LockedErrorFactory = (displayName: string) => (reason: BuddyNoAccountReason) => Error

/**
 * 装配结果里 **`apply()` 后续还要用** 的那部分。
 *
 * 只列真正被 region 之后代码引用的绑定；region 内部自用的（各家余额选择器、
 * 凭据解析器、`activeXxxAccountId` 之类）刻意**不**外泄 —— 它们是实现细节，
 * 泄出去只会让人以为可以外部改写。
 */
export interface ProviderWiring {
  readonly codearts: ReturnType<typeof registerCodeArtsLlm>
  readonly throwIfAllAccountsRateLimited: AllLimitedGuard
  readonly astudioLockedError: LockedErrorFactory
  readonly autoclawLockedError: LockedErrorFactory
  readonly buddy: BuddyAuth
  readonly buddyAdapter: ReturnType<typeof registerBuddyLlm>
  readonly workbuddy: BuddyAuth
  readonly workbuddyAdapter: ReturnType<typeof registerBuddyLlm>
  readonly lobsterai: LobsteraiAuth
  readonly lobsteraiAdapter: ReturnType<typeof registerLobsteraiLlm>
  readonly qoder: QoderAuth
  readonly qoderAdapter: ReturnType<typeof registerQoderLlm>
  readonly qoderCn: QoderAuth
  readonly qoderCnAdapter: ReturnType<typeof registerQoderLlm>
  readonly trae: TraeAuth
  readonly traeAdapter: ReturnType<typeof registerTraeLlm>
  readonly cline: ClineAuth
  readonly clineAdapter: ReturnType<typeof registerClineLlm>
  readonly loomy: LoomyAuth
  readonly loomyAdapter: ReturnType<typeof registerLoomyLlm>
  readonly raccoon: RaccoonAuth
  readonly raccoonAdapter: ReturnType<typeof registerRaccoonLlm>
  readonly minimax: MinimaxAuth
  readonly minimaxAdapter: ReturnType<typeof registerMinimaxLlm>
  readonly minimaxIntl: MinimaxAuth
  readonly minimaxIntlAdapter: ReturnType<typeof registerMinimaxLlm>
}
