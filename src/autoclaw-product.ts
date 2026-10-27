/**
 * AutoClaw（智谱清言桌面端）产品配置 —— 唯一真相源。
 *
 * ## 数据与协议来源
 *
 * - API 基址：`https://autoglm-acceleration-api.zhipuai.cn`
 * - 认证静态参数：`appId = '100003'`, `appKey = 'AUTOCLAW_STATIC_APP_KEY_PLACEHOLDER'`
 * - 核心模型：`zai_glm-5.3-flash`（实测免费畅通可用）、`zaicoding_glm-5.3`、`zai_auto`
 * - 协议：OpenAI Chat Completions 兼容，SSE text/event-stream 响应
 * - 406 绕过硬性约束：首条 message 必须为 system 且包含前缀
 *   `You are AutoClaw. Answer the user directly and concisely`
 *
 * ## 规格、实测记录与历史事故去哪找
 *
 * 本文件只留**行为约束**（改错的后果）。「这个数值是怎么测出来的」「哪个缺陷
 * 从哪次报障发现的」属于过程记录，放在：
 *
 * - `docs/autoclaw-models.md` —— 四个模型的窗口/输出/模态/扣费实测表（官方配置端点取证）
 * - `docs/autoclaw-login-and-effort.md` —— 登录、图片能力、思考档位的真机探测记录
 * - `docs/agent-notes/providers-autoclaw.md` —— 事故史：积分到期、JWT 死线、档位口径
 * - `docs/audit/pr111-autoclaw-audit.md` —— 两轮独立审计与变异验证
 */

export interface AutoclawFallbackModel {
  /** 模型 ID（传给上游的 model 标识，例如 zai_glm-5.3-flash）。 */
  readonly id: string
  /** UI 显示名称。 */
  readonly name: string
  /**
   * 真实上下文窗口大小（Token 数）。兜底值 1M (1,048,576)，与官方配置端点实测一致。
   *
   * ⚠️ **远端报文的键是 `contextWindow`（驼峰）**，上游用
   * `boundedPositiveInteger(value, 1e7)` 钳制、`>= 1e3` 才采纳。
   * 解析处见 `parseAutoclawRemoteModels`。取证与键名核对过程见
   * `docs/agent-notes/providers-autoclaw.md`。
   */
  readonly contextWindow: number
  /**
   * 最大输出 Token 数。
   *
   * ⚠️ **远端报文的键是 `maxTokens`**（不是 `max_output_tokens`），上游钳制在
   * `1e6`，且**`maxTokens` 必须 `< contextWindow`**，否则整条被丢弃。
   * ⇒ 本仓库 `parseAutoclawRemoteModels` 的候选别名里 `maxTokens` 在列。
   */
  readonly maxOutputTokens?: number
  /**
   * 是否支持图片输入。
   *
   * ⚠️ 远端用 **`input`** 数组，元素只接受 `"text"` / `"image"`；
   * **缺该字段或非数组时回落 `["text"]`** ⇒ 与「未知按不支持处理」的口径一致。
   *
   * ⚠️⚠️ **该字段以本仓库实测为准，不要按远端声明回推**：远端对
   * `zai_auto` 声明的是 `input: ["text"]`，实测却能正确读图（远端漏报形态，
   * loomy 同款）。实测记录见 `docs/autoclaw-login-and-effort.md`「图片能力」。
   */
  readonly supportsImage?: boolean
  /**
   * 是否归类为免费额度模型。
   *
   * ⚠️⚠️ **判据是「是否脱离钱包扣费」，不是「远端目录里有没有它」**。
   * 本家四个模型**全部走统一积分钱包**（每次请求约扣 1 点）⇒ 都是 `false`。
   * 误标 `true` 会让付费模型进「免费额度」分栏并绕开锁定提示，原委见
   * `docs/agent-notes/providers-autoclaw.md`。
   */
  readonly isFree?: boolean
}

/**
 * 上游认可的思考档位词汇表（**实测取证**，非推测）。
 *
 * 来源：桌面端 `dist\main.cjs` 的 `MODEL_THINKING_LEVELS`，同一常量还被
 * SQLite 的 `CHECK(thinking_level IN (...))` 约束引用 ⇒ 两处独立印证。
 *
 * ⚠️ 本仓库只声明其中**三档**（见 {@link AUTOCLAW_DECLARED_EFFORTS}），
 *   刻意**不**声明 `off`：关思考在本仓库语义里由「不传 `reasoningEffort`」表达，
 *   把 `off` 混进档位数组会让客户端多出一格「关闭」，且与兄弟渠道
 *   （buddy / raccoon / zcode）的档位轴不一致。
 *
 * ⚠️ 数组顺序 = **强度序（弱→强）**，不是「默认档排第一」——宿主把它当
 *   展示顺序且官方客户端直接 `map` 不排序（AGENTS.md 明文记载）。
 */
export const AUTOCLAW_THINKING_LEVELS = Object.freeze([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const)

/**
 * 编译期兜底模型表。
 *
 * ## ⚠️⚠️ 本表与远端目录**不完全一致**，且这是**有意保留**的
 *
 * 远端 `autoclaw-model-config` 只下发 3 条（`zai_auto` / `zai_auto-fast` /
 * `zaicoding_glm-5.3`），**不含 `zai_glm-5.3-flash`**；三个共有模型的三项能力
 * （`contextWindow` / `maxTokens` / `input`）与本表逐格一致。
 *
 * **为什么仍保留 `zai_glm-5.3-flash`**：「目录里没有」≠「不可用」——真机实测
 * 直接调它仍 200 且正常回复。合理解释是目录按账号/灰度裁剪，或它属「兼容保留」
 * 通道。
 *
 * ⚠️ 本表**必须如实登记**它不在目录里，否则后人看代码会以为目录里也有。
 * ⚠️ 若将来它真下线（调用返回 `400 非法模型`），本表要一并删掉它。
 *
 * ## 名称策略：**保留远端 name，只加品牌后缀**
 *
 * 远端 `name` 是 `Auto` / `Auto-Fast` / `GLM-5.3`（**不含品牌前缀**）。
 *
 * ⚠️ id 里的 `coding` 只是通道标识，**不是给用户看的名字**：`zaicoding_glm-5.3`
 *   的远端 `name` 逐字就是 `"GLM-5.3"` —— 它**就是** IDE 内置列表里那个
 *   `GLM-5.3`（消耗等级「高」也一致）。写成「GLM-5.3 Coding」会让用户以为那是
 *   另一个模型。
 *
 * ⇒ 凡「id 与 name 语义不一致」时**以远端 `name` 为准**：用户在 IDE 里看到什么，
 *   这里就显示什么。
 *
 * ✅ 只做一件事：**加 `AutoClaw` 品牌标记**。理由是 DSH 的模型选择器**跨渠道
 *   平铺**，不加前缀会与别的渠道的 `Auto` / `GLM-5.3` 混淆（见
 *   `docs/agent-notes/providers-buddy.md` 的「同名模型必须把品牌写进 name」）。
 */
export const AUTOCLAW_FALLBACK_MODELS: readonly AutoclawFallbackModel[] = [
  {
    // ⚠️ 远端目录里**没有**这一条，但实测**直接调用仍可用**（见上方说明）。
    id: 'zai_glm-5.3-flash',
    // 远端目录里没有这一条（故无权威 `name`），但 IDE 内置列表显示为
    // `GLM-5.3-Flash` ⇒ 跟 IDE 对齐成 `GLM-5.3 Flash`（空格版，与本表其余条目
    // 风格一致），仅加 `(AutoClaw)` 品牌后缀。
    name: 'GLM-5.3 Flash (AutoClaw)',
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    // ⚠️⚠️ **`true`，实测确认**（四个 `zai_*` 模型全部答对双判据测试图）。
    //   探针必须用**笔画够粗、尺寸够大**的图：早期用 64×64 细笔画图得到的是
    //   假阴性（模型读不出 ⇒ 误判「不支持」）。取证见
    //   `docs/autoclaw-login-and-effort.md`「图片能力」。
    supportsImage: true,
    /**
     * ⚠️⚠️ **`false`**：本家**没有**真正的免费模型。
     *
     * 扣减机制是统一积分钱包（实测每次请求约扣 1 点），钱包耗尽后同样受限 ⇒
     * 「脱离钱包」才是免费的判据。误标 `true` 会让它进「免费额度」分栏且绕开
     * 锁定提示，用户以为免费、实际在烧钱包。原委见
     * `docs/agent-notes/providers-autoclaw.md`。
     */
    isFree: false,
  },
  {
    id: 'zaicoding_glm-5.3',
    // ⚠️⚠️ 远端 `name` 逐字就是 `"GLM-5.3"` ⇒ 它**就是** IDE 内置列表里那个
    //   `GLM-5.3`（消耗等级「高」也对得上）。见上方「名称策略」。
    name: 'GLM-5.3 (AutoClaw)',
    contextWindow: 1048576,
    maxOutputTokens: 307200,
    supportsImage: true,
    isFree: false,
  },
  {
    id: 'zai_auto',
    // 远端 `name` 是 `"Auto"`（不含品牌）⇒ 加后缀以跨渠道区分。
    name: 'Auto (AutoClaw)',
    contextWindow: 1048576,
    maxOutputTokens: 393216,
    // ⚠️ **`true`**：远端声明 `input: ["text"]`，但实测能正确读图 ⇒
    //   远端声明**不完整**（Remote 漏报 input_modalities 形态，loomy 同款）。
    supportsImage: true,
    isFree: false,
  },
  {
    id: 'zai_auto-fast',
    // 远端 `name` 是 `"Auto-Fast"`（连字符，与 id 的 `auto-fast` 同形）。
    name: 'Auto-Fast (AutoClaw)',
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    // 远端唯一**明确声明** `input: ["text","image"]` 的模型（与实测一致）。
    supportsImage: true,
    isFree: false,
  },
]

/**
 * 本仓库对外声明、并作为**默认档**使用的思考档位。
 *
 * ## 为什么只声明三档、且默认 `high`
 *
 * 上游词汇表有 7 档（见 {@link AUTOCLAW_THINKING_LEVELS}），但实测取证表明
 * **推理量在档内波动跨 16 倍、区间完全重叠** ⇒ 无法用数据证明相邻档位
 * （如 `low` vs `medium`）存在可感知差异。
 *
 * ⇒ 只给**差异最可能显著的三个端点档**：「实际无差别」的档位等于给用户假选择。
 *
 * ### 默认 `high` 而不是 `max`
 *
 * - `max` 是「极限推理」：实测在难题上单次可跑 **170~192 秒**，日常对话等待
 *   代价过高；
 * - `high` 是智谱官方标注的**推荐默认**
 *   （`docs/autoclaw-models.md`：「【官方推荐默认】完整展开推导演算」）；
 * - 远端目录的 `reasoningLevel` 顺序也是 `["low","high","max"]`，`high` 居中是
 *   均衡位。
 *
 * ⚠️ 所以 `high` 是**折中**而**非**「证明最强可用」——它是「够用且不会让用户
 *   等两分钟」的那一档。要极限推理时用户可手动选 `max`。
 *
 * ⚠️ 顺序是**强度序（弱→强）**，不是「默认档排第一」：宿主把它当展示顺序，
 *   官方客户端直接 `map` 不排序（AGENTS.md 明文记载）⇒ 若把 `high` 排到首位，
 *   横向档位轴会变成「左强右弱」。踩坑记录见
 *   `docs/agent-notes/providers-autoclaw.md`。
 */
export const AUTOCLAW_DECLARED_EFFORTS = Object.freeze(['low', 'high', 'max'] as const)

/** 默认思考档：`high`（理由见 {@link AUTOCLAW_DECLARED_EFFORTS}）。 */
export const AUTOCLAW_DEFAULT_EFFORT = 'high' as const

/**
 * 各档的中文展示名（与 {@link AUTOCLAW_DECLARED_EFFORTS} 一一对应）。
 *
 * ⚠️ 单独一张表而不是内联在 adapter 里：`Record` 的类型能保证
 *   「新增档位忘了写名字」在**编译期**就红，而不是运行时显示 `undefined`。
 */
export const AUTOCLAW_EFFORT_LABELS: Readonly<Record<
  (typeof AUTOCLAW_DECLARED_EFFORTS)[number], string
>> = Object.freeze({
  low: '快速思考 (Low)',
  high: '深度思考 (High)',
  max: '极限推理 (Max)',
})

/**
 * 模型输入模态的**唯一定义处**（2026-10-17 审计 P0 修复）。
 *
 * ## 为什么必须是纯函数、且两个入口共用一份
 *
 * 修复前 `AutoclawAdapter` 的两个入口对**同一个模型**说了两套相反的话：
 *
 * | 入口 | 原写法 | 对 `zai_auto-fast` 的结论 |
 * |---|---|---|
 * | `resolveModel` | `known?.supportsImage ? ['text','image'] : ['text']` | 支持图片 |
 * | `listModels` | 硬编码 `['text']` | **不支持**图片 |
 *
 * 而宿主两处都会用，且**用途不同**（`dsh-llm/lib/index.js`）：
 *
 * - `resolveModel` 的那份 → `normalizeModelInfo` 的 `inputModalities` →
 *   **请求前门禁**（`index.js:2311`）：声明里没有 `image` 就把图片
 *   **投影成文本占位符**，声明里有则**原样放行**给适配器；
 * - `listModels` 的那份 → 模型选择器与聚合目录。
 *
 * ⇒ 两处不一致 = 「选择器说能看图 → 门禁放行 → 适配器抛错」，
 *   且同一 provider 内不同模型走两套图片通路（本仓库已记录 `accio` 那条
 *   教训：`['text']` 与省略**语义不同** —— 省略 = 未知 = 放行，
 *   显式 `['text']` = 明确不支持）。
 *
 * ## ⚠️ 为什么未知模型显式给 `['text']` 而不是省略
 *
 * 省略 = 「未知」= 宿主放行 ⇒ 不支持图片的模型会**静默忽略图片并幻觉**
 * （`docs/agent-notes/providers-accio.md` 记载：GLM 5.1 据此幻觉出答案）。
 * 故「不知道」一律按「不支持」处理：宁可少一次能力，不可多一次幻觉。
 *
 * @param entry 兜底表里的一条；`undefined` = 用户手填的未知模型 id。
 */
export function inputModalitiesOf(
  entry: AutoclawFallbackModel | undefined,
): readonly ['text'] | readonly ['text', 'image'] {
  return entry?.supportsImage === true ? ['text', 'image'] : ['text']
}

export const AUTOCLAW_API_BASE = 'https://autoglm-acceleration-api.zhipuai.cn'
export const AUTOCLAW_APP_ID = '100003'
export const AUTOCLAW_APP_KEY = 'AUTOCLAW_STATIC_APP_KEY_PLACEHOLDER'
export const AUTOCLAW_SOURCE_ID = 'autoclaw'
export const AUTOCLAW_PRODUCT_NAME = 'autoclaw'

/**
 * AutoClaw 客户端版本号（`X-Version` 头用）。
 *
 * ⚠️️ **推理请求必须带它**（2026-10-20 真机二分实测）。
 *
 * 国际站网关对 `X-Version` 是**硬校验**：
 * - 不带 → `HTTP 500 Internal Server Error`，**响应体为空**（无任何原因文案）；
 * - 带上 → `HTTP 200`。
 *
 * 二分定位（同一 body、只逐个加 header）：其余 9 个客户端头
 * （`X-Tm` / `X-Lang` / `X-Channel` / `User-Agent` / `X-Trace-Id` /
 * `X-Request-Id` / `X-Client-Type` / `x_trace_id` / `X-Session-Id`）
 * **单独加都不改变 500**，只有 `X-Version` 是关键项。
 *
 * ⚠️ 症状极具误导性：500 + 空响应体 ⇒ 既不像鉴权失败（那会 401/410000）、
 *    也不像参数错误（那会 400/406），用户与日志都看不出是「缺一个版本号头」。
 *
 * 取值自国际版客户端 `AutoClaw2.exe` 的 `ProductVersion`（`2.1.1.262` 取前三段）。
 */
export const AUTOCLAW_CLIENT_VERSION = '2.1.1'

export const AUTOCLAW_DEFAULT_CREDENTIAL_REF = 'AUTOCLAW_ACCOUNT_DEFAULT'

/**
 * 国际版（`autoclawintl`）的 API 基址 —— 从官方国际版客户端
 * `AutoClaw2\resources\app\dist\main.cjs` 的
 * `HTTP_ORIGIN_BY_ENVIRONMENT.overseas_release` 逐字节抄出（2026-10-20）。
 *
 * ⚠️ 该客户端的运行日志实测确认它在用这个主机：
 *    `{"redactedUrl":"https://autoglm-api.autoglm.ai","host":"autoglm-api.autoglm.ai","status":200}`
 */
export const AUTOCLAW_INTL_API_BASE = 'https://autoglm-api.autoglm.ai'
export const AUTOCLAW_INTL_DEFAULT_CREDENTIAL_REF = 'AUTOCLAWINTL_ACCOUNT_DEFAULT'

/**
 * AutoClaw 产品配置（国内 / 国际**两个实例**同一套协议实现）。
 *
 * ## ⚠️⚠️ 为什么是**两个 provider** 而不是「一个 provider 加站点参数」
 *
 * 与 `minimaxintl`（`src/minimax-product.ts` 文件头）同一条判据，三条全中：
 *
 * | 判据 | 国内 | 国际 | 是否分裂 |
 * |---|---|---|---|
 * | 账号体系 | 手机号 / `7c54a9ac…`（UUID 主键） | 邮箱 / `2c99dc99…` | **不互通** |
 * | API 主机 | `autoglm-acceleration-api.zhipuai.cn` | `autoglm-api.autoglm.ai` | 不同 |
 * | 登录方式 | 短信验证码（`agent-send-code` + `agent-login`） | **Z.ai OAuth** | 不同 |
 *
 * 实测佐证（2026-10-20）：拿国内签发的 token 打国际基址，三个端点全部拒绝
 * （`wallets` / `user-profile` → `410000 用户未登录`；推理 → `401 Invalid token`）
 * ⇒ **用户体系物理隔离**，不可能靠一个站点参数切换。
 *
 * ## 与 `zcode` 的差别（为什么它不拆）
 *
 * zcode 的国内（`bigmodel`）/ 国际（`zai`）是**同一套 OAuth 流程**，只是换域名，
 * 凭据里按渠道存 `bigmodel_access_token` / `zai_access_token` 两个字段。
 * 那边的「渠道」由 OAuth 提供方在**同一个账号体系内**区分，故一个 provider 足够。
 * autoclaw 这边连**登录协议都不同**，合并只会让两边逻辑互相污染。
 */
export interface AutoclawProduct {
  /** provider id。国内 `autoclaw`、国际 `autoclawintl`（全小写、无连字符）。 */
  readonly id: 'autoclaw' | 'autoclawintl'
  readonly displayName: string
  readonly apiBase: string
  readonly appId: string
  readonly appKey: string
  readonly product: string
  readonly defaultCredentialRef: string
  readonly fallbackModels: readonly AutoclawFallbackModel[]
  /**
   * 桌面端 **userData 目录名**（`%APPDATA%\<这个名字>\`）。
   *
   * ⚠️⚠️ **必须按产品区分，且只能有这一处真相源**（2026-10-20 审计 P0）。
   *
   * 国内版与国际版是**同一客户端的两份构建**（`isOversea` 是构建期常量），
   * userData 目录名不同 —— 实测：
   * - 国内构建：`AutoClaw-official`
   * - 国际构建：`AutoClaw-oversea-official`
   *
   * ## 为什么它不是「顺手加的一个字段」，而是 P0
   *
   * 该目录名有**三个读点**，且原先只有一处按产品判断：
   * 1. `probeAutoclawLocalCredential()`（一键导入）—— 已按产品传；
   * 2. `resolveDeviceId()`（登录/签到/续期三处请求体里的 `device_id`）—— 写死国内；
   * 3. 登录页 `/autoclaw/import-local`（`startAutoclawSmsLoginFlow` 内的本地
   *    HTTP 端点，用户点「⚡ 一键读取本机凭据」时触发）—— 写死国内。
   *
   * 第 3 条是**审计实测复现过的真实事故**：以 `product: AUTOCLAW_INTL` 起 flow 后
   * 请求该端点，被探测的路径是 `AutoClaw-official\Local State`（国内），而这条
   * 路径的结果会经 `started.result` **直接落盘**（不经过 `importLocalAccount`
   * 的归属校验）⇒ 国内凭据被写进 `AUTOCLAWINTL_ACCOUNT_*`，症状是「国际版卡片
   * 显示国内手机号且已过期」，全程无一处报错。
   *
   * ⇒ 收进产品配置后，三个读点都从 `product.userDataDirName` 取，**新增站点
   * 不可能再漏一处**（漏了是类型错误，不是静默失效）。
   */
  readonly userDataDirName: string
}

export const AUTOCLAW: AutoclawProduct = {
  id: 'autoclaw',
  displayName: 'AutoClaw (智谱)',
  apiBase: AUTOCLAW_API_BASE,
  appId: AUTOCLAW_APP_ID,
  appKey: AUTOCLAW_APP_KEY,
  product: AUTOCLAW_PRODUCT_NAME,
  defaultCredentialRef: AUTOCLAW_DEFAULT_CREDENTIAL_REF,
  fallbackModels: AUTOCLAW_FALLBACK_MODELS,
  userDataDirName: 'AutoClaw-official',
}

/**
 * 国际版实例 —— **只差三个字段**（id / 显示名 / 基址 / 凭据 ref），
 * `appId` / `appKey` / `product` / 模型表与国内**逐字节相同**（实测两站通用）。
 *
 * ⚠️ `appId: '100003'` 与 `appKey` 在国际站同样被接受：
 *    用它们给 `autoglm-api.autoglm.ai` 签名后，`oauth-captcha-config` 返回
 *    `code=0 SUCCESS`（与国内站同码），说明签名中间件认同一对凭据。
 *
 * ⚠️ **登录方式尚未接入**：国内走短信（`AutoclawAuth.loginWithCode`），
 *    国际走 **Z.ai OAuth**（浏览器授权 + `POST /userapi/overseasv1/zai-oauth-login`）。
 *    OAuth 的 `client_id`（`client_EnD0QI8bLRFT8cciLp389Q`）与
 *    `state.dh = SHA256(deviceId)` 已逆向确认，`state.nh` 来源未知 ——
 *    在打通之前，本 provider **只能通过手工注入 token 使用**。
 */
export const AUTOCLAW_INTL: AutoclawProduct = {
  id: 'autoclawintl',
  displayName: 'AutoClaw (国际版)',
  apiBase: AUTOCLAW_INTL_API_BASE,
  appId: AUTOCLAW_APP_ID,
  appKey: AUTOCLAW_APP_KEY,
  product: AUTOCLAW_PRODUCT_NAME,
  defaultCredentialRef: AUTOCLAW_INTL_DEFAULT_CREDENTIAL_REF,
  fallbackModels: AUTOCLAW_FALLBACK_MODELS,
  // ⚠️ 国际构建的 userData 目录（实测）。见 `AutoclawProduct.userDataDirName` 的
  //    P0 注释：三个读点（一键导入 / device_id / 登录页 import-local）都取这里。
  userDataDirName: 'AutoClaw-oversea-official',
}
