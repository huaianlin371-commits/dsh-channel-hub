/**
 * `src/rpc-payload-spec.ts` 自己的行为用例 + **规格表与类型声明的一致性守卫**。
 *
 * ## 为什么这个文件必须存在
 *
 * ⑧ 把 `jet-hub-rpc.ts` 里 45 处 `payload as RpcXxxRequest`（纯编译期断言）
 * 换成了运行时的 `validateRpcPayload`。校验器本身写错会被行为用例抓到，
 * 但**规格表腐烂**抓不到 —— 表是手写的，`types.ts` 的接口也是手写的，
 * 两侧各改一半是最容易发生的形态（2026-10-27 的五渠道白名单事故就是
 * 「手写清单 + 没有交叉校验」）。
 *
 * 所以这里有一组 **AST 三方差集**用例：
 *
 * | 比什么 | 谁 vs 谁 | 抓什么 |
 * |---|---|---|
 * | 方法集合 | `RPC_PAYLOAD_SPEC` ↔ `switch (method)` 的 case 标签 | 表里编了个不存在的方法 / case 碰了 payload 却没登记 |
 * | 字段集合 | `RPC_PAYLOAD_SPEC` ↔ `Rpc*Request` 接口 | 表里编了个类型里没有的字段 / 类型加了字段表没跟上 |
 * | 可选性 | 同上 | 合法调用被判 bad-request（`login.poll.provider` 就是这么暴露的） |
 *
 * ## ⚠️ 这一组是**源码级断言**，不是行为断言
 *
 * 它们靠读 `src/types.ts` / `src/jet-hub-rpc.ts` 的 AST 判断，改源码就可能红。
 * 那是**设计意图**：表的用途就是镜像源码，源码变了表必须跟着变。
 * 唯一的豁免是 `KNOWN_DRIFT`（见下），每一项都必须写清为什么故意不一致。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import {
  RPC_PAYLOAD_SPEC,
  validateRpcPayload,
  type RpcFieldKind,
} from '../../src/rpc-payload-spec.js'

const SRC = join(import.meta.dirname, '../../src')
const typesFile = ts.createSourceFile(
  'types.ts',
  readFileSync(join(SRC, 'types.ts'), 'utf8'),
  ts.ScriptTarget.ESNext,
  true,
)
const rpcFile = ts.createSourceFile(
  'jet-hub-rpc.ts',
  readFileSync(join(SRC, 'jet-hub-rpc.ts'), 'utf8'),
  ts.ScriptTarget.ESNext,
  true,
)

/** `Rpc*Request` 接口名 → 字段列表（名字 / 是否可选 / 类型原文）。 */
const INTERFACES = new Map<string, Array<{ name: string; optional: boolean; type: string }>>()
for (const st of typesFile.statements) {
  if (!ts.isInterfaceDeclaration(st)) continue
  const name = st.name.text
  if (!name.startsWith('Rpc') || !name.endsWith('Request')) continue
  const fields: Array<{ name: string; optional: boolean; type: string }> = []
  for (const m of st.members) {
    if (!ts.isPropertySignature(m) || m.name === undefined || !ts.isIdentifier(m.name)) continue
    fields.push({
      name: m.name.text,
      optional: m.questionToken !== undefined,
      type: m.type === undefined ? '' : m.type.getText(typesFile),
    })
  }
  INTERFACES.set(name, fields)
}

/**
 * 主 `switch (method)` 的 case 分组。
 *
 * 空 case（`case 'a': case 'b': { … }`）必须归到同一组：`credits.permanentLock`
 * 与 `loomy.permanentLock` 就是这种形态，共用一个 case 体。
 */
interface CaseGroup {
  labels: string[]
  /** case 体里出现的 `Rpc*Request` 类型名（递归进交叉类型 / `Partial<>`）。 */
  interfaces: string[]
  /** case 体里是否出现 `payload` 这个标识符（= 这个方法真的读入参）。 */
  touchesPayload: boolean
}

function readCaseGroups(): CaseGroup[] {
  let mainSwitch: ts.SwitchStatement | undefined
  const findSwitch = (n: ts.Node): void => {
    if (mainSwitch !== undefined) return
    if (ts.isSwitchStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === 'method') {
      mainSwitch = n
      return
    }
    ts.forEachChild(n, findSwitch)
  }
  findSwitch(rpcFile)
  if (mainSwitch === undefined) throw new Error('jet-hub-rpc.ts 里找不到 switch (method)')

  const groups: CaseGroup[] = []
  let pending: string[] = []
  for (const clause of mainSwitch.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue
    pending.push(ts.isStringLiteral(clause.expression) ? clause.expression.text : '(非字面量)')
    if (clause.statements.length === 0) continue

    const interfaces = new Set<string>()
    let touchesPayload = false
    const walk = (n: ts.Node): void => {
      // 类型位置上的 Rpc*Request 标识符。必须认交叉类型与 Partial<> —— 只认
      // `as X` 的直系 TypeReferenceNode 会漏掉
      // `payload as RpcPermanentLockRequest & RpcLoomyPermanentLockRequest`。
      if (ts.isIdentifier(n) && /^Rpc\w+Request$/.test(n.text)) {
        const p = n.parent
        if (
          p !== undefined
          && (ts.isTypeReferenceNode(p) || ts.isIntersectionTypeNode(p) || ts.isUnionTypeNode(p)
            || ts.isTypeOperatorNode(p) || ts.isArrayTypeNode(p))
        ) {
          interfaces.add(n.text)
        }
      }
      // `payload` 作为**变量引用**出现（排除 `{ payload: … }` 这种键名）。
      if (ts.isIdentifier(n) && n.text === 'payload') {
        const p = n.parent
        const isKeyName = p !== undefined && ts.isPropertyAssignment(p) && p.name === n
        if (!isKeyName) touchesPayload = true
      }
      ts.forEachChild(n, walk)
    }
    for (const s of clause.statements) walk(s)

    groups.push({ labels: pending, interfaces: [...interfaces], touchesPayload })
    pending = []
  }
  return groups
}

const CASE_GROUPS = readCaseGroups()
const CASE_LABELS = new Set(CASE_GROUPS.flatMap((g) => g.labels))
const METHOD_GROUP = new Map<string, CaseGroup>()
for (const g of CASE_GROUPS) for (const l of g.labels) METHOD_GROUP.set(l, g)

/**
 * 已知的「故意不一致」，每条都必须有理由。
 *
 * 只允许「表比类型**更松**」（表少要求一个字段 ⇒ 合法调用照过）。
 * 反方向的漂移（表比类型严）一律不许豁免：那会让真实客户端调用被拒。
 */
const KNOWN_DRIFT: ReadonlyArray<{ method: string; field: string; why: string }> = [
  {
    method: 'loomy.permanentLock',
    field: 'provider',
    why: '宿主把 provider 硬钉成 LOOMY.id（jet-hub-rpc.ts:5758 的 method === 判断），'
      + '载荷里的 provider 一概不看。类型因为与 credits.permanentLock 共用 case 体'
      + '（交叉类型）而带上它，但本方法对载荷无要求。',
  },
]

/** 类型原文 → 允许的 kind。返回 `undefined` 表示「这条类型不做 kind 判定」。 */
function allowedKinds(typeText: string): RpcFieldKind[] | undefined {
  if (typeText === 'string') return ['string', 'text']
  if (typeText === 'number') return ['number']
  if (typeText === 'boolean') return ['boolean']
  if (typeText === 'string[]' || typeText === 'Array<string>') return ['string-array']
  // 联合字面量（`'zh' | 'en'`）、类型别名（`PanelEntry` / `UiLocale`）、
  // `unknown`（备份载荷）、`Partial<…>`（patch）都不做 kind 判定：
  // 它们的语义校验在 case 体内，表只卡基础形状。
  return undefined
}

/**
 * 已知的「表比类型更松」的 kind 放宽，每条都必须写清消费方在哪一行归一。
 *
 * 与 `KNOWN_DRIFT` 的区别：那个是**字段级**不一致（表里干脆没登记），
 * 这个是**同一字段但 kind 更松**（登记了，只是不按声明类型卡）。
 * 反方向的收紧一律不许豁免 —— 那会把合法调用判成 bad-request。
 */
const KNOWN_KIND_WIDENING: ReadonlyArray<{ method: string; field: string; why: string }> = [
  {
    method: 'captcha.contribute',
    field: 'elapsedMs',
    why: 'case 体自己钳制：jet-hub-rpc.ts:8070 的 `typeof req.elapsedMs === "number" '
      + '&& Number.isSafeInteger(…) && …` 不成立时退回 0。校验层若按 number 卡，'
      + '`null` 会被判 bad-request，而旧行为是「退回 0 继续收 param」。',
  },
  {
    method: 'captcha.contribute',
    field: 'interactive',
    why: 'case 体只认 `req.interactive === true`（jet-hub-rpc.ts:8072），'
      + '`"yes"` / `1` 一律当「无感通过」。这条归一**本身就是被测行为**'
      + '（tests/unit/zcode-carrier-rpc.spec.ts 传字符串 "yes" 断言 interactive 仍为 0）。',
  },
]

describe('validateRpcPayload：入参校验的行为契约', () => {
  it('未登记的方法一律放行（前缀改道的 opencode./gemini. 不在本表内）', () => {
    expect(validateRpcPayload('opencode.something', null)).toEqual({ ok: true, value: null })
    expect(validateRpcPayload('gemini.chat', { weird: 1 })).toEqual({
      ok: true,
      value: { weird: 1 },
    })
  })

  it('全可选字段的方法收到 undefined / null 归一成空对象（不是错误）', () => {
    // `usage.tokenLedger` 只有可选的 limit。
    expect(validateRpcPayload('usage.tokenLedger', undefined)).toEqual({ ok: true, value: {} })
    expect(validateRpcPayload('usage.tokenLedger', null)).toEqual({ ok: true, value: {} })
    expect(validateRpcPayload('usage.tokenLedger', {})).toEqual({ ok: true, value: {} })
  })

  it('有必填字段却收到标量：点名第一个必填字段，而不是笼统说「要是对象」', () => {
    const r = validateRpcPayload('account.list', null)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.error.field).toBe('provider')
    expect(r.error.message).toContain('provider')
    // 文案里要带收到的实际值，用户才能自查（这里是 null）。
    expect(r.error.message).toContain('null')
  })

  it('缺必填字段 ⇒ bad-request 并点出字段名', () => {
    const r = validateRpcPayload('account.list', {})
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.error).toEqual({ field: 'provider', message: '缺少必填字段 provider' })
  })

  it('显式 null 一律拒 —— 包括**可选**字段（忘了赋值要当场暴露）', () => {
    // force 是可选字段；传 null 与「没传」必须区分开。
    const r = validateRpcPayload('usage.badge', { provider: 'buddy', force: null })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.error.field).toBe('force')
    expect(r.error.message).toContain('不能为 null')
  })

  it('kind:any 的字段连 null 也放行（消费方自己归一）', () => {
    // captcha.contribute 的 elapsedMs 是 any：case 体里非安全整数退回 0。
    const r = validateRpcPayload('captcha.contribute', { param: 'p', elapsedMs: null })
    expect(r.ok).toBe(true)
  })

  it('未知键原样保留（客户端版本比插件新时不能互斥）', () => {
    const r = validateRpcPayload('account.list', { provider: 'buddy', futureField: 42 })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.value).toEqual({ provider: 'buddy', futureField: 42 })
  })

  it('string 拒空串与纯空白串（空 provider 会拼出 ...//models 这种静默错路由）', () => {
    expect(validateRpcPayload('account.list', { provider: '' }).ok).toBe(false)
    expect(validateRpcPayload('account.list', { provider: '   ' }).ok).toBe(false)
    expect(validateRpcPayload('account.list', { provider: 'buddy' }).ok).toBe(true)
  })

  it('text 允许空串但**仍拒非字符串**（{ xff: 0 } 不是「清除」，是 bug）', () => {
    expect(validateRpcPayload('minimax.setXff', { xff: '' }).ok).toBe(true)
    expect(validateRpcPayload('minimax.setXff', { xff: 0 }).ok).toBe(false)
    expect(validateRpcPayload('minimax.setXff', { xff: '1.2.3.4' }).ok).toBe(true)
  })

  it('number 拒 NaN / Infinity / 字符串数字', () => {
    expect(validateRpcPayload('usage.tokenLedger', { limit: 10 }).ok).toBe(true)
    expect(validateRpcPayload('usage.tokenLedger', { limit: Number.NaN }).ok).toBe(false)
    expect(validateRpcPayload('usage.tokenLedger', { limit: Number.POSITIVE_INFINITY }).ok).toBe(false)
    expect(validateRpcPayload('usage.tokenLedger', { limit: '10' }).ok).toBe(false)
  })

  it('boolean 严格：字符串 "false" 一律拒（开关静默反转比报错危险）', () => {
    expect(validateRpcPayload('gateway.setEnabled', { enabled: false }).ok).toBe(true)
    expect(validateRpcPayload('gateway.setEnabled', { enabled: 'false' }).ok).toBe(false)
    expect(validateRpcPayload('gateway.setEnabled', { enabled: 0 }).ok).toBe(false)
  })

  it('string-array 拒非数组与含非字符串元素', () => {
    expect(validateRpcPayload('model.setDisabledMany', {
      provider: 'buddy', modelIds: ['a', 'b'], disabled: true,
    }).ok).toBe(true)
    expect(validateRpcPayload('model.setDisabledMany', {
      provider: 'buddy', modelIds: 'a,b', disabled: true,
    }).ok).toBe(false)
    expect(validateRpcPayload('model.setDisabledMany', {
      provider: 'buddy', modelIds: [1, 'a'], disabled: true,
    }).ok).toBe(false)
  })

  it('object 拒数组（patch: [] 在 Object.assign 里「成功」但不产生任何变更）', () => {
    expect(validateRpcPayload('account.update', { accountId: 'a1', patch: {} }).ok).toBe(true)
    expect(validateRpcPayload('account.update', { accountId: 'a1', patch: [] }).ok).toBe(false)
    expect(validateRpcPayload('account.update', { accountId: 'a1', patch: null }).ok).toBe(false)
  })

  it('captcha.contribute 缺 param 不炸（case 体整段是清洗器，空串由 putSuppliedParam 判垃圾）', () => {
    expect(validateRpcPayload('captcha.contribute', {}).ok).toBe(true)
    expect(validateRpcPayload('captcha.contribute', { param: '' }).ok).toBe(true)
    // 但非字符串仍然拒：那是调用方写错了，不是「没有 param」。
    expect(validateRpcPayload('captcha.contribute', { param: 42 }).ok).toBe(false)
  })

  it('login.poll 的 provider 可省（宿主根本不读它，六组替身 harness 只传 accountId）', () => {
    expect(validateRpcPayload('login.poll', { accountId: 'a1' }).ok).toBe(true)
    expect(validateRpcPayload('login.poll', {}).ok).toBe(false)
  })
})

describe('★ 规格表 ↔ 源码：方法集合必须逐字对齐', () => {
  it('表里每个方法都是 jet-hub-rpc.ts 真实存在的 case 标签（不许编造方法）', () => {
    const invented = Object.keys(RPC_PAYLOAD_SPEC).filter((m) => !CASE_LABELS.has(m))
    expect(invented).toEqual([])
  })

  it('每个会读 payload 的 case 都必须登记（不许漏登记）', () => {
    const missing: string[] = []
    for (const group of CASE_GROUPS) {
      if (!group.touchesPayload) continue
      // 空 case 链里只有最后一支有 case 体，故按组判断、逐个标签落登记要求。
      for (const label of group.labels) {
        if (RPC_PAYLOAD_SPEC[label] === undefined) missing.push(label)
      }
    }
    expect(missing).toEqual([])
  })

  it('不读 payload 的 case 刻意不登记（登记了就等于凭空发明必填字段）', () => {
    const overRegistered: string[] = []
    for (const [method, group] of METHOD_GROUP) {
      if (group.touchesPayload) continue
      if (RPC_PAYLOAD_SPEC[method] !== undefined) overRegistered.push(method)
    }
    expect(overRegistered).toEqual([])
  })
})

describe('★ 规格表 ↔ types.ts：字段名与可选性必须一致', () => {
  it('每个方法的每个字段都在对应的 Rpc*Request 接口里声明过', () => {
    const drift: string[] = []
    for (const [method, spec] of Object.entries(RPC_PAYLOAD_SPEC)) {
      const group = METHOD_GROUP.get(method)
      expect(group, `${method} 在 switch 里找不到`).toBeDefined()
      const candidates = (group as CaseGroup).interfaces
        .map((n) => INTERFACES.get(n))
        .filter((x): x is NonNullable<typeof x> => x !== undefined)
      expect(candidates.length, `${method} 的 case 体里没有 Rpc*Request 类型标注`).toBeGreaterThan(0)
      for (const field of spec.fields) {
        const declared = candidates.some((fields) => fields.some((f) => f.name === field.name))
        if (!declared) drift.push(`${method}.${field.name}（表里有，类型里没有）`)
      }
    }
    expect(drift).toEqual([])
  })

  it('类型里声明的字段一个都不能漏登记（豁免项见 KNOWN_DRIFT）', () => {
    const exempt = new Set(KNOWN_DRIFT.map((d) => `${d.method}.${d.field}`))
    const drift: string[] = []
    for (const [method, spec] of Object.entries(RPC_PAYLOAD_SPEC)) {
      const group = METHOD_GROUP.get(method) as CaseGroup
      // 只在「恰好一个候选接口」时做反向比对：多接口（交叉类型）说明两个端点
      // 共用 case 体，各自认哪些字段由正向用例 + KNOWN_DRIFT 保证。
      if (group.interfaces.length !== 1) continue
      const fields = INTERFACES.get(group.interfaces[0] as string) ?? []
      const registered = new Set(spec.fields.map((f) => f.name))
      for (const f of fields) {
        if (registered.has(f.name)) continue
        if (exempt.has(`${method}.${f.name}`)) continue
        drift.push(`${method}.${f.name}（类型里有，表里没有）`)
      }
    }
    expect(drift).toEqual([])
  })

  it('可选性必须一致 —— 表比类型严会把合法调用判成 bad-request', () => {
    const drift: string[] = []
    for (const [method, spec] of Object.entries(RPC_PAYLOAD_SPEC)) {
      const group = METHOD_GROUP.get(method) as CaseGroup
      const candidates = group.interfaces
        .map((n) => INTERFACES.get(n))
        .filter((x): x is NonNullable<typeof x> => x !== undefined)
      for (const field of spec.fields) {
        const declared = candidates.flat().find((f) => f.name === field.name)
        if (declared === undefined) continue
        if (declared.optional === field.optional) continue
        drift.push(
          `${method}.${field.name}（表 optional=${String(field.optional)} / `
          + `类型 optional=${String(declared.optional)}）`,
        )
      }
    }
    expect(drift).toEqual([])
  })

  it('基础类型能对上（string/number/boolean/string[] 四种明确形态）', () => {
    const widened = new Set(KNOWN_KIND_WIDENING.map((d) => `${d.method}.${d.field}`))
    const drift: string[] = []
    for (const [method, spec] of Object.entries(RPC_PAYLOAD_SPEC)) {
      const group = METHOD_GROUP.get(method) as CaseGroup
      const candidates = group.interfaces
        .map((n) => INTERFACES.get(n))
        .filter((x): x is NonNullable<typeof x> => x !== undefined)
      for (const field of spec.fields) {
        if (widened.has(`${method}.${field.name}`)) continue
        const declared = candidates.flat().find((f) => f.name === field.name)
        if (declared === undefined) continue
        const allowed = allowedKinds(declared.type)
        if (allowed === undefined) continue
        if (allowed.includes(field.kind)) continue
        drift.push(
          `${method}.${field.name}（表 kind=${field.kind} / 类型 ${declared.type}）`,
        )
      }
    }
    expect(drift).toEqual([])
  })

  it('KNOWN_KIND_WIDENING 的每条放宽都仍然真实存在且确实是放宽（收紧了要删掉）', () => {
    for (const entry of KNOWN_KIND_WIDENING) {
      const spec = RPC_PAYLOAD_SPEC[entry.method]
      expect(spec, `放宽项指向不存在的方法 ${entry.method}`).toBeDefined()
      const field = (spec as { fields: readonly { name: string; kind: RpcFieldKind }[] }).fields
        .find((f) => f.name === entry.field)
      expect(field, `放宽项 ${entry.method}.${entry.field} 表里已无此字段`).toBeDefined()

      const group = METHOD_GROUP.get(entry.method) as CaseGroup
      const declared = group.interfaces
        .map((n) => INTERFACES.get(n))
        .filter((x): x is NonNullable<typeof x> => x !== undefined)
        .flat()
        .find((f) => f.name === entry.field)
      expect(declared, `放宽项 ${entry.method}.${entry.field} 在类型里不存在`).toBeDefined()

      // 必须真的是「表更松」：表 kind 不在类型允许的 kind 集合里，才叫放宽。
      const allowed = allowedKinds((declared as { type: string }).type)
      if (allowed !== undefined) {
        expect(
          allowed.includes((field as { kind: RpcFieldKind }).kind),
          `放宽项 ${entry.method}.${entry.field} 其实已经符合类型了，删掉这条豁免`,
        ).toBe(false)
      }
    }
  })

  it('KNOWN_DRIFT 的每条豁免都仍然真实存在（豁免过期了要删掉，否则它会掩盖新的漂移）', () => {
    for (const entry of KNOWN_DRIFT) {
      const spec = RPC_PAYLOAD_SPEC[entry.method]
      expect(spec, `豁免项指向不存在的方法 ${entry.method}`).toBeDefined()
      const registered = (spec as { fields: readonly { name: string }[] }).fields
        .some((f) => f.name === entry.field)
      expect(registered, `豁免项 ${entry.method}.${entry.field} 已经登记了，删掉这条豁免`).toBe(false)

      const group = METHOD_GROUP.get(entry.method) as CaseGroup
      const declared = group.interfaces
        .map((n) => INTERFACES.get(n))
        .filter((x): x is NonNullable<typeof x> => x !== undefined)
        .flat()
        .some((f) => f.name === entry.field)
      expect(declared, `豁免项 ${entry.method}.${entry.field} 在类型里也不存在了`).toBe(true)
    }
  })
})
