/**
 * 面板中英切换的内核单测。
 *
 * 这里是 `i18n-core.js` 唯一的护栏：它没有 React 依赖，测试环境能直接 import。
 *
 * ## 两条真实缺陷的回归
 *
 * 1. **恒等映射键抢占模式**（2026-10-27）：字典里 `{0}`、`{0} {1}` 这类
 *    「译文 = 原文」的键被编成 `^(.+?)$`，又按 key 长度排在 `合计 {0}` 前面，
 *    于是「合计 5」被翻成它自己 —— 表现是「所有模板串都不翻译」，而精确
 *    匹配却是好的。修法：编译模式时跳过恒等映射与纯占位符键。
 * 2. **排序判据用错字段**：原先按 `key.length` 排，`{0} {1}`（7 字符）压过
 *    `合计 {0}`（6 字符）。改成按**字面量长度**排后，更具体的模式才会先命中。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { DICT_EN } from '../../plugin-src/client/i18n-dict.js'
import { UI_LOCALES, applyLocale, getLocale, t, tpl } from '../../plugin-src/client/i18n-core.js'

beforeEach(() => {
  applyLocale('zh')
})

describe('语言状态', () => {
  it('默认中文，与历史行为一致（没点过按钮的用户无感）', () => {
    expect(getLocale()).toBe('zh')
  })

  it('只认 zh / en 两个值，脏值静默忽略', () => {
    expect(UI_LOCALES).toEqual(['zh', 'en'])
    expect(applyLocale('EN')).toBe(false)
    expect(applyLocale('english')).toBe(false)
    expect(applyLocale('zh-CN')).toBe(false)
    expect(getLocale()).toBe('zh')
  })

  it('切到同一个值不算变化（不触发无谓的重渲染）', () => {
    expect(applyLocale('zh')).toBe(false)
    expect(applyLocale('en')).toBe(true)
    expect(applyLocale('en')).toBe(false)
    expect(getLocale()).toBe('en')
  })
})

describe('t()：中文原文 → 当前语言', () => {
  it('中文下原样返回（连字典都不查）', () => {
    expect(t('供应商')).toBe('供应商')
    expect(t('合计 {0}')).toBe('合计 {0}')
  })

  it('英文下按字典命中', () => {
    applyLocale('en')
    expect(t('供应商')).toBe('Provider')
    expect(t('网关')).toBe('Gateway')
    expect(t('成功')).toBe('Success')
    expect(t('失败')).toBe('Failed')
  })

  it('字典里没有的串退回中文原文 —— 绝不返回 key 或空串', () => {
    applyLocale('en')
    const missing = '这条文案故意不在字典里'
    expect(t(missing)).toBe(missing)
  })

  it('非字符串与空串原样返回（调用点可能传 undefined）', () => {
    applyLocale('en')
    expect(t('')).toBe('')
    expect(t(undefined)).toBeUndefined()
    expect(t(null)).toBeNull()
  })

  it('★ 品牌名不翻译：改了它会违反用户的硬性要求', () => {
    applyLocale('en')
    expect(t('大肥鱼饭碗')).toBe('大肥鱼饭碗')
  })

  /**
   * ★★ 2026-10-27 缺陷的正面回归。
   *
   * 字典里曾经有 `{0}` / `{0} {1}` 这类恒等映射键，编成模式后能匹配任意串，
   * 把「合计 5」这种本该走 `合计 {0}` 的模板抢走。断言「运行时的拼接结果
   * 能被翻译」才覆盖得到这条 —— 只测 `t('合计 {0}')` 是测不到的，因为那是
   * 精确匹配、从来没坏过。
   */
  it('★★ 运行期拼出的模板串能被模式匹配翻到（恒等键不得抢占）', () => {
    applyLocale('en')
    expect(t('合计 5')).toBe('Total 5')
    expect(t('合计 12')).toBe('Total 12')
  })

  it('★ 具体模式优先于笼统模式（按字面量长度排序）', () => {
    applyLocale('en')
    // `Cline · {0} 个账号`（字面量 6）必须压过 `{0} 个`（字面量 1）。
    expect(t('Cline · 3 个账号')).toBe('Cline · 3 accounts')
  })

  it('翻过的结果有缓存，重复调用返回同一个字符串值', () => {
    applyLocale('en')
    const first = t('供应商')
    const second = t('供应商')
    expect(first).toBe(second)
    expect(first).toBe('Provider')
  })
})

describe('tpl()：显式模板填参', () => {
  it('中文下只做填参，不做翻译', () => {
    expect(tpl('合计 {0}', 5)).toBe('合计 5')
  })

  it('英文下先译模板再填参', () => {
    applyLocale('en')
    expect(tpl('合计 {0}', 5)).toBe('Total 5')
    expect(tpl('复制全部 {0} 个 ID', 7)).toBe('Copy all 7 IDs')
  })

  it('同一占位符出现多次都能填上', () => {
    applyLocale('en')
    expect(tpl('{0} / {0}', 3)).toBe('3 / 3')
  })

  it('缺参时保留占位符原样 —— 显示 `{0}` 比显示 `undefined` 更容易看出是缺陷', () => {
    applyLocale('en')
    expect(tpl('合计 {0}', undefined)).toBe('Total {0}')
    expect(tpl('合计 {0}')).toBe('Total {0}')
  })

  it('非字符串入参转成字符串，不抛错', () => {
    expect(tpl(42)).toBe('42')
  })
})

describe('字典本身的卫生（防止下次合并翻译时又混进坏键）', () => {
  it('不得有纯占位符键（`{0}` 这种能匹配任意串）', () => {
    const bad = Object.keys(DICT_EN).filter((key) => {
      if (!/\{\d+\}/.test(key)) return false
      return key.replace(/\{\d+\}/g, '').replace(/\s+/g, '').length === 0
    })
    expect(bad, `纯占位符键会把所有模板串吃掉：${JSON.stringify(bad)}`).toEqual([])
  })

  it('不得有恒等映射键（译文与原文逐字相同，翻了等于没翻）', () => {
    const bad = Object.keys(DICT_EN).filter((key) => /\{\d+\}/.test(key) && DICT_EN[key] === key)
    expect(bad, `恒等映射键同样会抢占模式：${JSON.stringify(bad)}`).toEqual([])
  })

  it('每条译文都不为空', () => {
    const empty = Object.entries(DICT_EN).filter(([, value]) => typeof value !== 'string' || value === '')
    expect(empty, `空译文会让界面出现空白：${JSON.stringify(empty.map(([k]) => k))}`).toEqual([])
  })

  it('占位符集合逐条对齐（中文有几个洞，英文就得有几个对应的洞）', () => {
    const mismatched = []
    for (const [cn, en] of Object.entries(DICT_EN)) {
      const holesOf = (text) => [...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',')
      if (holesOf(cn) !== holesOf(en)) mismatched.push([cn, en])
    }
    expect(mismatched, `占位符对不齐会在运行时漏填：${JSON.stringify(mismatched.slice(0, 5))}`).toEqual([])
  })
})
