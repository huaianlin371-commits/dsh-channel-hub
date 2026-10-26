/**
 * 面板文案的中英切换（React 侧）。
 *
 * 与 `i18n-core.js` 分开的原因见那个文件的头注释（纯函数模块不能拉 React）。
 *
 * ## `h()` 是干什么的
 *
 * 全插件的 864 处 `React.createElement(...)` 里，**文案几乎都直接写在实参上**
 * （`React.createElement('button', null, '一键签到')`）。要在不逐处改源码的前提下
 * 让这些文案跟着语言走，最省事的做法是：**换掉渲染入口**。
 *
 * `h()` 是 `React.createElement` 的包装：
 *
 * - 第二个实参若像 props 对象，就把其中**字符串型的 `title` / `aria-label` /
 *   `placeholder` / `alt`** 过一遍 `t()`；
 * - 其余字符串型子节点（从第三个实参起，含数组与 `null` 占位）逐个过 `t()`；
 * - 非字符串、组件、嵌套 `createElement` 的结果一律原样透传。
 *
 * 于是 `React.createElement` → `h` 是一次机械替换，源码里仍写着中文原文
 * （可读性、可 grep 性都保住），运行时按当前语言出译文。
 *
 * ⚠️ **不做深层遍历**：子节点里已经是 `createElement(...)` 结果的对象不进去
 * （那是另一棵子树，它自己会用 `h` 渲染）。这样每层只处理自己的一层，
 * 不会出现 O(n²) 的重复翻译。
 *
 * ## `useLocale()`
 *
 * 订阅模块级语言状态，返回 `{ locale, t, tpl, h }`。组件里只写
 * `const { t, h } = useLocale();` 即可。
 *
 * ⚠️ 组件**必须**在渲染时调用它（而不是模块顶层取一次 `t`），否则切语言后
 * 组件不会重渲染 —— 模块级函数没有 hook 的订阅能力。
 */

import * as React from 'react';

import { applyLocale, getLocale, subscribeLocale, t, tpl } from './i18n-core.js';

/**
 * 会被翻译的 props 键。
 *
 * 只收**纯展示型**字符串键：`className` / `data-*` / `key` / `id` / `value`
 * 这类参与逻辑或选择器的键绝不能进（翻一下就找不到 DOM 或样式失效）。
 */
const TRANSLATABLE_PROPS = new Set(['title', 'aria-label', 'placeholder', 'alt']);

/** 看着像 props 对象吗（纯对象、非 null、非 React 元素）。 */
function looksLikeProps(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  // React 元素带 $$typeof；子节点数组/元素都走「不是 props」这条路。
  if (value.$$typeof !== undefined) return false;
  return true;
}

/**
 * 翻译一个子节点：字符串查表，数组逐项处理，其余原样。
 *
 * @param {unknown} child
 * @returns {unknown}
 */
function translateChild(child) {
  if (typeof child === 'string') return t(child);
  if (Array.isArray(child)) return child.map(translateChild);
  return child;
}

/**
 * `React.createElement` 的翻译包装。签名与它完全一致。
 *
 * @param {any} type
 * @param {any} [props]
 * @param {...unknown} children
 * @returns {any}
 */
export function h(type, props, ...children) {
  let nextProps = props;
  if (looksLikeProps(props)) {
    let copied = null;
    for (const key of Object.keys(props)) {
      if (!TRANSLATABLE_PROPS.has(key)) continue;
      const value = props[key];
      if (typeof value !== 'string') continue;
      const translated = t(value);
      if (translated === value) continue;
      if (copied === null) copied = { ...props };
      copied[key] = translated;
    }
    if (copied !== null) nextProps = copied;
  }
  const nextChildren = children.length === 0 ? children : children.map(translateChild);
  return React.createElement(type, nextProps, ...nextChildren);
}

/**
 * 订阅当前界面语言。
 *
 * 返回 `{ locale, t, tpl, h }`：`locale` 只用于需要按语言分支的地方（极少），
 * 正常渲染用 `t` / `tpl` / `h` 就够。
 *
 * @returns {{ locale: 'zh' | 'en', t: typeof t, tpl: typeof tpl, h: typeof h }}
 */
export function useLocale() {
  const [locale, setLocale] = React.useState(getLocale);
  React.useEffect(() => subscribeLocale(setLocale), []);
  return { locale, t, tpl, h };
}

/**
 * 把宿主状态里的语言读进模块状态（启动时调用一次）。
 *
 * 读失败**静默保持中文**：语言偏好读不到不该阻止面板渲染。
 *
 * @param {{ rpcCall: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> }} options
 */
export async function loadUiLocale({ rpcCall }) {
  try {
    const result = await rpcCall('ui.locale.get', {});
    const value = result?.locale;
    if (value === 'en' || value === 'zh') applyLocale(value);
  } catch (caught) {
    console.warn('[jet-hub] 读取界面语言失败，保持中文', caught);
  }
}

/**
 * 切换语言并写回宿主状态。
 *
 * 先本地生效再写回（乐观更新）：写回失败时界面已经切了，比「点了没反应」
 * 好得多；错误只打日志，不弹窗打断用户。
 *
 * @param {{ rpcCall: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> }} options
 * @param {'zh' | 'en'} next
 */
export async function setUiLocale({ rpcCall }, next) {
  if (!applyLocale(next)) return;
  try {
    await rpcCall('ui.locale.set', { locale: next });
  } catch (caught) {
    console.warn('[jet-hub] 保存界面语言失败（本次会话仍按新语言显示）', caught);
  }
}
