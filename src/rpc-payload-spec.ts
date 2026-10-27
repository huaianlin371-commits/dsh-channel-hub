/**
 * RPC 入参规格表（架构审查 ⑧）。
 *
 * ## 为什么需要这张表
 *
 * `jet-hub-rpc.ts` 的 `handleMethod` 里，45 个 case 全都是
 * `const req = payload as RpcXxxRequest` —— **纯类型断言，零运行时校验**。
 * TypeScript 的 `as` 只在编译期起作用，`payload` 来自
 * `await request.json()`（`:3704`），是**客户端自报的任意 JSON**：
 *
 * - `payload: null` ⇒ `req.provider` 直接抛 `TypeError: Cannot read properties
 *   of null` ⇒ 落进 `:3730` 的 catch ⇒ 客户端收到
 *   `jet-hub/handler-failed` + `"Cannot read properties of null (reading
 *   'provider')"` —— 用户看到的是**一条 JS 引擎的内部报错**，而真实原因
 *   （客户端传错/版本不匹配）完全不可读。
 * - `payload: { provider: 123 }` ⇒ 拼进 URL 模板变成 `.../123/...` 静默查错
 *   渠道；`{ enabled: 'false' }`（字符串）⇒ `!== false` 判据为真 ⇒ **开关
 *   反向生效**，且不报任何错。
 * - `{ orderedIds: 'a,b' }` ⇒ `Array.isArray` 兜住了，但同类字段在别的 case
 *   里没有兜 ⇒ 部分方法严、部分方法松，**同一个 bug 类在不同端点上表现不一致**。
 *
 * 这张表把「每个方法要什么形状」变成数据，由 `validateRpcPayload` 统一执行，
 * 于是所有端点对入参的态度一致：**能归一的归一，不能归一的回可读的
 * `bad-request`**，绝不让 JS 引擎的 TypeError 漏到用户面前。
 *
 * ## 与 `types.ts` 的关系（刻意的重复，不是遗漏）
 *
 * `types.ts` 的 `Rpc*Request` 接口是**编译期契约**，本表是**运行时镜像**。
 * 两者必须一致，否则就是「类型说有、运行时没查」。`rpc-payload-spec.spec.ts`
 * 用 TypeScript AST 逐方法比对这两份声明，**任何一侧改了而另一侧没跟上都会
 * 直接红**——这是防止本表腐烂的唯一手段（手写清单必然腐烂，2026-10-27 的
 * 五渠道白名单事故就是这么来的）。
 *
 * ⚠️ 不要在 case 内部再加零散的 `typeof` 检查：本表已经覆盖了必填字段的
 * 存在性与基础类型。case 内部只保留**语义级**校验（如 `provider` 是否在
 * 白名单内、`accountId` 是否真的存在）。
 */

/** 字段的运行时形状。 */
export type RpcFieldKind =
  /** 非空字符串。空串与纯空白串都算非法（`provider: ''` 拼出的 URL 无意义）。 */
  | 'string'
  /**
   * 任意字符串，**空串合法**。
   *
   * ⚠️ 这个 kind 不是「宽松版 string」，而是「空串在这条链路上有明确语义」的
   * 标记。已知三处（2026-10-27 逐条核实源码后确认）：
   *
   * - `minimax.setXff` 的 `xff`：`''` = **清除 XFF 设置**（`jet-hub-rpc.ts:7932`
   *   的判据就是 `typeof req.xff !== 'string'`，注释明写「空串表示清除」）；
   *   客户端「清除设置」按钮传的正是空串（`plugin-src/client/jet-hub.js:1775`）。
   * - `captcha.contribute` 的 `param`：客户端在 `state.param ?? ''` 时也会调一次，
   *   空串由 `putSuppliedParam` 自己判垃圾并回 `accepted: false`——这是**正常
   *   业务结果**，不是入参错误，不该在校验层变成 `bad-request`。
   * - `account.create` 的 `minimaxIntlProxy` / `geminiProxy`：`''` = **直连**
   *   （`jet-hub-rpc.ts:4500` / `:4760` 的 `typeof … === 'string' ? …trim() : ''`）。
   */
  | 'text'
  /** 有限数字（`NaN` / `Infinity` 拒绝）。 */
  | 'number'
  /** 布尔值。`'true'` / `1` 一律拒绝——开关类字段的静默反转比报错危险得多。 */
  | 'boolean'
  /** `string[]`（每个元素都必须是字符串）。 */
  | 'string-array'
  /** 普通对象（非 null、非数组）。内部形状由 case 自己校验。 */
  | 'object'
  /**
   * 任意 JSON 值，**连 `null` 也不校验**。
   *
   * ⚠️ 只给「消费方自己会把非法值归一」的字段用，且必须在表里写清归一逻辑
   * 在哪一行 —— 否则它就是「忘了校验」的遮羞布。已知两处，都在
   * `captcha.contribute`（该 case 整段就是一个清洗器，见表内注释）。
   */
  | 'any'

/** 一个字段的运行时要求。 */
export interface RpcFieldSpec {
  readonly name: string
  readonly kind: RpcFieldKind
  /**
   * 缺省（`undefined`）是否合法。
   *
   * ⚠️ 这里说「缺省合法」不等于「`null` 合法」：本表一律把显式的 `null`
   * 视为非法。理由是调用方传 `null` 几乎总是 bug（`JSON.stringify` 把
   * `undefined` 键丢掉、把 `null` 留着），而把 `null` 悄悄当缺省处理会让
   * 「忘了赋值」这种错永远不暴露。
   */
  readonly optional: boolean
}

/**
 * 一个方法的入参规格。
 *
 * `fields` 为空数组 = 该方法**不接受任何入参**（`usage.tokenLedger` 之类
 * 全是可选字段的方法也允许传对象，见 `allowEmptyPayload`）。
 */
export interface RpcMethodSpec {
  readonly fields: readonly RpcFieldSpec[]
}

/** 全部方法的规格表。键必须与 `jet-hub-rpc.ts` 的 `case` 标签逐字一致。 */
export const RPC_PAYLOAD_SPEC: Readonly<Record<string, RpcMethodSpec>> = {
  'account.list': { fields: [{ name: 'provider', kind: 'string', optional: false }] },
  'account.create': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      // `phone` 只在 zcode 的短信分支用；`account.create` 自身不读它
      // （读点在 `login.sendSms`），但接口里声明了就一并校验。
      { name: 'phone', kind: 'string', optional: true },
      { name: 'zcodeProvider', kind: 'string', optional: true },
      // 空串 = 直连（见 `RpcFieldKind` 的 `text` 注释）。
      { name: 'minimaxIntlProxy', kind: 'text', optional: true },
      { name: 'accioRegion', kind: 'string', optional: true },
      { name: 'geminiProxy', kind: 'text', optional: true },
      // 下面两个是「新建账号」弹窗的预选结果，宿主在 `account.create` 体内读
      // （`jet-hub-rpc.ts:4898` 的 `autoclawMode`、`:5062` 的 `astudioLoginMethod`）。
      // 2026-10-27 补登：此前 `RpcCreateAccountRequest` 漏声明这两个字段，
      // 宿主只能 `payload as { autoclawMode?: string }` 硬转 —— 类型说有、
      // 运行时没查的典型。取值都是 `'local' | 'web' | 'sms'`，语义级校验
      // 留在 case 内（`loginMethod !== 'web'` 等），这里只卡类型。
      { name: 'astudioLoginMethod', kind: 'string', optional: true },
      { name: 'autoclawMode', kind: 'string', optional: true },
    ],
  },
  'account.update': {
    fields: [
      { name: 'accountId', kind: 'string', optional: false },
      { name: 'patch', kind: 'object', optional: false },
    ],
  },
  'account.delete': { fields: [{ name: 'accountId', kind: 'string', optional: false }] },
  'account.reorder': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'orderedIds', kind: 'string-array', optional: false },
    ],
  },
  'account.refresh': { fields: [{ name: 'accountId', kind: 'string', optional: false }] },
  'login.poll': {
    fields: [
      { name: 'accountId', kind: 'string', optional: false },
      // ⚠️ 可选，尽管 `RpcPollLoginRequest` 声明成必填（2026-10-27 核实）。
      //
      // `case 'login.poll'` 的体内**根本不读 `req.provider`**（用 TS AST 抽出
      // 整个 case 体扫描，`req.*` 只出现 `accountId`；`provider` 那 4 次全是
      // `entry.provider === OFFICEACE.id` 之类，读的是账号池里的实体）。客户端
      // 会顺手传 `{ accountId, provider }`（`plugin-src/client/jet-hub.js:3894`），
      // 但宿主不用它 —— 声明成必填就是在要求调用方传一个没人读的字段。
      //
      // 影响面：`officeace-*` / `astudio-login-credits` / `codely-login` 六组
      // 替身 harness 全都只传 `{ accountId }`，若保持必填，这些合法调用会
      // 一起被判 bad-request —— 那是**校验层在制造故障**，不是它该干的事。
      { name: 'provider', kind: 'string', optional: true },
    ],
  },
  'login.sendSms': {
    fields: [
      { name: 'accountId', kind: 'string', optional: false },
      { name: 'provider', kind: 'string', optional: false },
      { name: 'phone', kind: 'string', optional: false },
    ],
  },
  'login.submitSms': {
    fields: [
      { name: 'accountId', kind: 'string', optional: false },
      { name: 'provider', kind: 'string', optional: false },
      { name: 'code', kind: 'string', optional: false },
    ],
  },
  'onboarding.status': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'accountId', kind: 'string', optional: false },
    ],
  },
  /**
   * 与 `loomy.permanentLock` 共用同一个 case 体（`jet-hub-rpc.ts:5715` / `:5720`），
   * 但两者对 `provider` 的态度**相反**，故必须分成两条登记：
   *
   * - 本方法（`credits.permanentLock`）**认** `provider`，缺了就拼不出查询键；
   * - `loomy.permanentLock` 是历史端点名，宿主把 provider 硬钉成 `LOOMY.id`
   *   （`:5723` 的注释：「即便载荷里带了也别照着执行」）⇒ 对载荷**无要求**。
   *
   * ⚠️ 若把两者合成一条「provider 必填」，老客户端 bundle 调
   * `loomy.permanentLock` 时会突然收到 `bad-request` —— 那正是
   * `:5717` 注释里说的「直接删会让 Loomy 面板的按钮静默失效」的同一个坑。
   */
  'credits.permanentLock': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'locked', kind: 'boolean', optional: true },
    ],
  },
  'loomy.permanentLock': {
    fields: [{ name: 'locked', kind: 'boolean', optional: true }],
  },
  'onboarding.claim': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'accountId', kind: 'string', optional: false },
    ],
  },
  'account.retest': { fields: [{ name: 'accountId', kind: 'string', optional: false }] },
  'account.retestAll': { fields: [{ name: 'provider', kind: 'string', optional: false }] },
  'account.test': {
    fields: [
      { name: 'accountId', kind: 'string', optional: false },
      { name: 'modelId', kind: 'string', optional: true },
    ],
  },
  'account.reset': { fields: [{ name: 'accountId', kind: 'string', optional: false }] },
  'account.resetAll': { fields: [{ name: 'provider', kind: 'string', optional: false }] },
  'credits.status': { fields: [{ name: 'provider', kind: 'string', optional: false }] },
  'credits.claimAll': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'runTasks', kind: 'boolean', optional: true },
      { name: 'budgetMs', kind: 'number', optional: true },
    ],
  },
  'credits.balances': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      // ⚠️ 这里刻意**比 case 内的守卫更严**（2026-10-27 决定）。
      //
      // case 里写的是 `Array.isArray(req?.accountIds) ? new Set(...filter(...)) : undefined`
      // —— 传字符串 `'a1'` 或 `[1,'a1']` 都会被**静默当成「省略」**，于是
      // 本来只想查 1 个号的请求变成查**全部**账号：一次 N 倍的上游请求，
      // 用户看到的只是「面板慢了几秒」，没有任何地方报错。
      //
      // ⇒ 校验层在这里回 `bad-request` 点出字段名，让客户端那个 bug 当场可见。
      // 这不是「行为回归」，是把静默的降级换成可读的拒绝。
      { name: 'accountIds', kind: 'string-array', optional: true },
      { name: 'force', kind: 'boolean', optional: true },
    ],
  },
  'cline.quota': { fields: [{ name: 'provider', kind: 'string', optional: false }] },
  'cline.requestLog': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'accountId', kind: 'string', optional: false },
      { name: 'limit', kind: 'number', optional: true },
    ],
  },
  'buddy.compensationStatus': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'accountId', kind: 'string', optional: false },
    ],
  },
  'buddy.claimCompensation': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'accountId', kind: 'string', optional: false },
    ],
  },
  'model.list': { fields: [{ name: 'provider', kind: 'string', optional: false }] },
  'model.setDisabled': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'modelId', kind: 'string', optional: false },
      { name: 'disabled', kind: 'boolean', optional: false },
    ],
  },
  'model.clearDead': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'modelId', kind: 'string', optional: true },
    ],
  },
  'model.setDisabledMany': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'modelIds', kind: 'string-array', optional: false },
      { name: 'disabled', kind: 'boolean', optional: false },
    ],
  },
  'model.setAllDisabled': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'disabled', kind: 'boolean', optional: false },
      { name: 'closeProvider', kind: 'boolean', optional: true },
    ],
  },
  'provider.status': { fields: [{ name: 'providers', kind: 'string-array', optional: false }] },
  'provider.setEnabled': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'enabled', kind: 'boolean', optional: false },
    ],
  },
  'provider.setOrder': { fields: [{ name: 'order', kind: 'string-array', optional: false }] },
  'gateway.setEnabled': { fields: [{ name: 'enabled', kind: 'boolean', optional: false }] },
  'gateway.setAllowLan': { fields: [{ name: 'allowLan', kind: 'boolean', optional: false }] },
  'nativeSearch.setEnabled': { fields: [{ name: 'enabled', kind: 'boolean', optional: false }] },
  'panelEntry.set': { fields: [{ name: 'entry', kind: 'string', optional: false }] },
  'ui.locale.set': { fields: [{ name: 'locale', kind: 'string', optional: false }] },
  'minimax.setXff': { fields: [{ name: 'xff', kind: 'text', optional: false }] },
  'captcha.contribute': {
    fields: [
      // ⚠️ 下面三个字段全部**宽容**，这是 case 体的既定契约，不是本表的疏漏。
      //
      // 这条 RPC 的载荷是**内部载体的尽力而为上报**（一次性供给槽），
      // `case 'captcha.contribute'`（`jet-hub-rpc.ts:8059`）整段就是一个
      // 清洗器：`param` 非字符串时当 `''` 交给 `putSuppliedParam` 自己判垃圾、
      // `elapsedMs` 非安全整数时退回 0、`interactive` 只在 `=== true` 时为真。
      //
      // 在这里改成严格校验的代价是**丢掉整个 param**（用户侧表现为「内部载体
      // 突然不可用」），换来的只是「少一次无害调用」—— 不划算。校验层只负责
      // 挡住会让 case 体抛 TypeError 的形状，而这条 case 体对任何形状都不抛。
      { name: 'param', kind: 'text', optional: true },
      { name: 'elapsedMs', kind: 'any', optional: true },
      // `interactive` 同理：case 体只认 `=== true`，`'yes'` / `1` 一律当「无感通过」。
      // 这条「非 true 即 false」的归一**本身就是被测行为**（
      // `tests/unit/zcode-carrier-rpc.spec.ts:207` 传的是字符串 `'yes'`，
      // 断言统计里 interactive 仍是 0）—— 若在校验层拒掉，这条用例就只能测到
      // bad-request，永远测不到归一逻辑。
      { name: 'interactive', kind: 'any', optional: true },
    ],
  },
  'backup.export': { fields: [{ name: 'accountIds', kind: 'string-array', optional: true }] },
  'backup.import': {
    fields: [
      // `RpcBackupImportRequest.payload` 的类型是 `unknown`（编译期故意放开，
      // 因为备份文件是外部产物），但 `importBackup` 的第一句就是
      // `assertBackupPayload(raw)`，它的**第一条**判据正是
      // 「必须是对象、不能是 null、不能是数组」（`src/backup.ts`）。
      //
      // ⇒ 这里用 `object` 与那份实现逐字对齐：形状不对的备份在校验层就回
      // `bad-request`，而不是一路走进 `assertBackupPayload` 抛
      // `BackupFormatError` 再被外层 catch 成 `jet-hub/handler-failed`
      // （后者在界面上显示成「未知故障」，用户看不出是备份文件坏了）。
      { name: 'payload', kind: 'object', optional: false },
      { name: 'mode', kind: 'string', optional: true },
    ],
  },
  'usage.badge': {
    fields: [
      { name: 'provider', kind: 'string', optional: false },
      { name: 'force', kind: 'boolean', optional: true },
    ],
  },
  'usage.tokenLedger': { fields: [{ name: 'limit', kind: 'number', optional: true }] },
  'usage.tokenLedgerHistory': {
    fields: [
      { name: 'sinceDays', kind: 'number', optional: true },
      { name: 'fromDay', kind: 'string', optional: true },
      { name: 'toDay', kind: 'string', optional: true },
    ],
  },
  'usage.tokenLedgerDeleteDay': {
    fields: [
      // 语义校验（是不是合法的 `YYYY-MM-DD`）留在 case 内由
      // `isValidTokenLedgerDayKey` 负责；这里只保证它是字符串，
      // 免得 `day: 20260101`（数字）一路走到正则里被当成非法日期。
      { name: 'day', kind: 'string', optional: false },
    ],
  },
  'usage.badgePreference': {
    fields: [
      // ⚠️ `preference` 是**字符串枚举** `'auto' | 'subscription' | 'credits'`
      // （`src/badge-preferences.ts:47` 的 `BadgePreference`），不是对象。
      //
      // 2026-10-27 修正：本表最初把它生成成了 `object`（生成器把 `BadgePreference`
      // 这个 `typeof X[number]` 别名当成了对象类型）。若不改，客户端每次
      // `writePreference('credits')`（`plugin-src/client/index.js:259`）都会被
      // 校验层判成 `bad-request` —— 徽标偏好从此存不进去，而**现有测试一条都
      // 测不到**（`usage-badge-client.spec.ts:245` 只断言客户端源码里有这行
      // `rpcCall`，没有真正打一次端点）。这类「类型别名被生成器猜错」的坑
      // 只能靠 `rpc-payload-spec.spec.ts` 的 AST 交叉比对兜住。
      //
      // 枚举语义（是不是三者之一）仍由 case 内的
      // `BADGE_PREFERENCES.includes(...)` 判，这里只卡类型。
      { name: 'preference', kind: 'string', optional: true },
    ],
  },
  'usage.autoCheckin': {
    fields: [
      { name: 'enabled', kind: 'boolean', optional: true },
      { name: 'dismiss', kind: 'boolean', optional: true },
    ],
  },
}

/** 校验失败的原因（进 `bad-request` 的 message，要能直接给用户看）。 */
export interface RpcPayloadError {
  readonly field?: string
  readonly message: string
}

/**
 * 按 `kind` 判断一个值是否合法。
 *
 * 返回 `true` 表示通过；`false` 表示不通过（调用方负责拼可读消息）。
 */
function matchesKind(value: unknown, kind: RpcFieldKind): boolean {
  switch (kind) {
    case 'any':
      return true
    case 'string':
      // 空串与纯空白串都拒：`provider: ''` 拼出的 URL 是 `...//models`，
      // 会静默命中错误路由而不是报错。
      return typeof value === 'string' && value.trim().length > 0
    case 'text':
      // 空串合法，但**非字符串仍然拒**：`{ xff: 0 }` 不是「清除」，是 bug。
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'string-array':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
    case 'object':
      // ⚠️ 刻意排除数组：`patch: []` 在 `Object.assign` 里能「成功」但不产生
      // 任何字段变更，属于静默无效。
      return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}

/** 拼一句能直接展示给用户的话（含收到的实际值，便于用户自查）。 */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  if (typeof value === 'string') return value.length > 40 ? `字符串「${value.slice(0, 40)}…」` : `字符串「${value}」`
  if (typeof value === 'object') return '对象'
  return `${typeof value} ${String(value)}`
}

/** `kind` → 给用户看的中文要求。 */
const KIND_LABEL: Readonly<Record<RpcFieldKind, string>> = {
  string: '非空字符串',
  text: '字符串',
  number: '有限数字',
  boolean: '布尔值 true/false',
  'string-array': '字符串数组',
  object: '对象',
  any: '任意值',
}

/**
 * 校验一个 RPC 载荷。
 *
 * ## 三种返回
 *
 * - `{ ok: true, value }`：`value` 是**原对象**（不深拷贝、不裁剪未知键）。
 *   未知键刻意保留：客户端的版本可能比插件新，多传的字段应该被忽略而不是
 *   报错——否则插件升级会与旧客户端互斥。
 * - `{ ok: false, error }`：`error.message` 可直接回给用户。
 *
 * ## 为什么载荷不是对象也接受
 *
 * 全可选字段的方法（`usage.tokenLedger`）在客户端侧常常 `payload: {}`；
 * 但 `payload: undefined` 也可能出现（`JSON.stringify` 丢键）。这两种都归一
 * 成空对象后继续校验，不当作错误——它们**没有必填字段**，空对象是合法输入。
 * 只有「方法有必填字段」时，非对象载荷才会因为字段缺失而报错，报错文案也
 * 会点名缺哪个字段，比「payload must be object」有用得多。
 */
export function validateRpcPayload(
  method: string,
  payload: unknown,
): { ok: true, value: unknown } | { ok: false, error: RpcPayloadError } {
  const spec = RPC_PAYLOAD_SPEC[method]
  // 未登记的方法交给调用方的 `default` 分支（回 `unknown method`），
  // 这里不越权判错——`opencode.*` / `gemini.*` 等前缀改道的方法也不在本表内。
  if (spec === undefined) return { ok: true, value: payload }

  const hasRequired = spec.fields.some((f) => !f.optional)
  const isPlainObject = typeof payload === 'object' && payload !== null && !Array.isArray(payload)

  if (!isPlainObject) {
    if (!hasRequired && (payload === undefined || payload === null)) {
      return { ok: true, value: {} }
    }
    // 有必填字段却给了标量：点出**第一个**必填字段名，用户能立刻对上。
    const first = spec.fields.find((f) => !f.optional)
    return {
      ok: false,
      error: {
        field: first?.name,
        message: first === undefined
          ? `载荷必须是对象（收到 ${describeValue(payload)}）`
          : `缺少必填字段 ${first.name}（收到 ${describeValue(payload)}）`,
      },
    }
  }

  const record = payload as Record<string, unknown>
  for (const field of spec.fields) {
    const value = record[field.name]
    if (value === undefined) {
      if (field.optional) continue
      return { ok: false, error: { field: field.name, message: `缺少必填字段 ${field.name}` } }
    }
    // `any` = 这条链路上**任何形状都不会出错**，于是连 `null` 也放行。
    //
    // 为什么不套用下面那条「显式 null 一律拒」：那条规则的用途是让「忘了赋值」
    // 当场暴露，前提是**该字段真的会被读成有意义的类型**。`any` 字段恰恰相反
    // —— 消费方自己会把非法值归一（`captcha.contribute` 的 `elapsedMs: null`
    // 就是退回 0），在这里拒掉反而会把一次无害调用变成错误。
    if (field.kind === 'any') continue
    // 显式 null 一律拒（含可选字段）：见 `RpcFieldSpec.optional` 的注释。
    if (value === null) {
      return { ok: false, error: { field: field.name, message: `字段 ${field.name} 不能为 null` } }
    }
    if (!matchesKind(value, field.kind)) {
      return {
        ok: false,
        error: {
          field: field.name,
          message: `字段 ${field.name} 必须是${KIND_LABEL[field.kind]}（收到 ${describeValue(value)}）`,
        },
      }
    }
  }
  return { ok: true, value: record }
}
