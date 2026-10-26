/**
 * 面板文案的中英切换内核（**纯逻辑，无 React**）。
 *
 * 单独成文件的原因：`quota-format.js` / `credits-format.js` / `credit-expiry.js`
 * 这些纯函数模块会被 Node 单测直接 import，一旦它们为了 `t()` 而拉进 React，
 * 单测就会因为宿主模块表缺失而挂掉。故本文件**只依赖字典**；需要 React 的
 * `useLocale()` 与 `h()` 在 `i18n-react.js`。
 *
 * ## 设计
 *
 * - 文案的**源语言是中文**：源码里写的就是中文，`t()` 在 `zh` 下原样返回，
 *   切到 `en` 时按字典查英文。
 * - 查不到的串**退回中文原文**，绝不显示 key 或空串 —— 面板里有近千条文案，
 *   漏翻一条不该变成空白。
 * - 带插值的文案有两道兜底：① 源码里显式写成 `tpl('合计 {0}', sum)` 的走
 *   模板翻译；② 源码里仍是 `` `合计 ${sum}` `` 的，运行时拼出来是「合计 5」，
 *   由 {@link translate} 的**模式匹配**兜住（字典 key 写成 `合计 {0}`，
 *   加载时编译成正则）。第二道是刻意的：把 260 处模板串全改成 `tpl()`
 *   改动面太大、太容易改错，而模式匹配对「前缀 + 数字 + 后缀」这类文案
 *   命中率足够高。
 * - 结果有**进程内缓存**：`t()` 在渲染路径上被调用上千次，字典有近千条，
 *   不缓存的话每次渲染都要跑一遍正则列表。
 *
 * ## 为什么不做成 React Context
 *
 * 本插件的组件散在 8 个文件、由 5 处槽位各自注册，Context Provider 得包在
 * 每一处槽位外面（`panel-entry.js` 的 main/settings.section、`index.js` 的
 * plugins.bundle.config / conversation.input.right），漏一处那棵子树就永远
 * 拿不到语言。模块级状态 + 订阅没有这个覆盖面问题。
 */

import { DICT_EN } from './i18n-dict.js';

/** 支持的界面语言（与宿主 RPC 的校验表逐字一致）。 */
export const UI_LOCALES = ['zh', 'en'];

/** 各语言的显示名，给切换按钮做 aria-label 与 tooltip。 */
export const UI_LOCALE_LABELS = { zh: '中文', en: 'English' };

/** 当前界面语言。默认中文 —— 与历史行为完全一致，没点过按钮的用户无感。 */
let locale = 'zh';

/** 订阅者集合（各组件的 `useLocale()`）。 */
const listeners = new Set();

/** 翻译结果缓存：原文 → 译文。切换语言时整体清空。 */
let cache = new Map();

/**
 * 从 `DICT_EN` 里编译出来的模板正则表，惰性构建。
 *
 * 元素形如 `{ pattern, indices, template }`：`pattern` 是整串锚定的正则，
 * `indices` 是各捕获组对应的占位符编号（`{0}` 的 0），`template` 是英文模板。
 */
let patterns = null;

/** 读当前界面语言。 */
export function getLocale() {
  return locale;
}

/**
 * 订阅语言变化。
 *
 * @param {(next: 'zh' | 'en') => void} listener
 * @returns {() => void} 取消订阅
 */
export function subscribeLocale(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 切换界面语言并广播。
 *
 * 非法取值**静默忽略**（不抛错）：这个值可能来自宿主状态文件的旧版本或手改，
 * 让一个脏值把整个面板炸掉不值得。
 *
 * @param {string} next
 * @returns {boolean} 是否真的变了
 */
export function applyLocale(next) {
  if (next !== 'zh' && next !== 'en') return false;
  if (next === locale) return false;
  locale = next;
  cache = new Map();
  for (const listener of [...listeners]) {
    try {
      listener(locale);
    } catch (caught) {
      console.warn('[jet-hub] 语言切换的订阅者抛错（已忽略）', caught);
    }
  }
  return true;
}

/** 正则元字符转义（模式里除了占位符，其余部分都要按字面量匹配）。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 模板 key 里**去掉占位符与空白**后剩下的字面量字数。
 *
 * 这是模式优先级的唯一判据：字面量越长，这条模式越具体、越不该被别的
 * 笼统模式抢先。
 *
 * @param {string} key
 * @returns {number}
 */
function literalLength(key) {
  return key.replace(/\{\d+\}/g, '').replace(/\s+/g, '').length;
}

/**
 * 把字典里带 `{n}` 的 key 编译成整串锚定的正则。
 *
 * ## 两道过滤（2026-10-27 修的真实缺陷）
 *
 * 字典里混着 `{0}`、`{0}{1}`、`{0} {1}` 这类**恒等映射**键（译文和原文
 * 逐字相同，收它们是翻译清单切块的副产物）。这类键编成模式后是
 * `^(.+?)$` / `^(.+?)(.+?)$` —— 能匹配**任何**字符串，而且原按 key 长度
 * 排序时它们排在 `合计 {0}` 前面，于是「合计 5」被 `{0} {1}` 抢走、翻成
 * 自己。现象是「模板串一律不翻译，看起来像字典没生效」，但精确匹配
 * （`合计 {0}` → `Total {0}`）却是好的 —— 极易误判成缓存问题。
 *
 * 故：① **跳过恒等映射**（翻了等于没翻，匹配它毫无收益）；
 * ② **跳过字面量为 0 的键**（纯占位符，必然吃掉一切）。
 *
 * 剩下的按**字面量长度降序**排：`缓存命中 {0} 已用`（字面量 6）会排在
 * `{0} 已用`（字面量 2）之前，更具体的优先命中。
 */
function buildPatterns() {
  const built = [];
  for (const [key, value] of Object.entries(DICT_EN)) {
    if (!/\{\d+\}/.test(key)) continue;
    if (value === key) continue;
    const literal = literalLength(key);
    if (literal === 0) continue;
    const indices = [];
    let source = '^';
    for (const part of key.split(/(\{\d+\})/)) {
      if (part === '') continue;
      const hole = /^\{(\d+)\}$/.exec(part);
      if (hole === null) {
        source += escapeRegExp(part);
        continue;
      }
      indices.push(Number(hole[1]));
      source += '(.+?)';
    }
    source += '$';
    built.push({ pattern: new RegExp(source), indices, template: value, literal, length: key.length });
  }
  built.sort((left, right) => right.literal - left.literal || right.length - left.length);
  return built;
}

/**
 * 英文下的查表：先整串精确匹配，再按模板模式匹配。
 *
 * @param {string} text
 * @returns {string}
 */
function translate(text) {
  const exact = DICT_EN[text];
  if (typeof exact === 'string') return exact;
  if (patterns === null) patterns = buildPatterns();
  for (const entry of patterns) {
    const matched = entry.pattern.exec(text);
    if (matched === null) continue;
    // 捕获组按出现顺序排，占位符编号未必连续（`{1} … {0}` 也合法）。
    return entry.template.replace(/\{(\d+)\}/g, (whole, raw) => {
      const slot = entry.indices.indexOf(Number(raw));
      return slot === -1 ? whole : matched[slot + 1];
    });
  }
  return text;
}

/**
 * 翻译一条文案。
 *
 * 中文下**直接返回原文**（连缓存都不查）：这是绝大多数用户的路径，不该为
 * 一个没用上的功能付开销。
 *
 * @param {string} text 源码里的中文原文（也是字典的 key）
 * @returns {string}
 */
export function t(text) {
  if (typeof text !== 'string' || text === '') return text;
  if (locale === 'zh') return text;
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const result = translate(text);
  cache.set(text, result);
  return result;
}

/**
 * 翻译一条显式带占位符的模板并填参。
 *
 * 缺参时**保留占位符原样**而不是塞 `undefined`：漏一个实参的文案显示成
 * `已清除 {0} 条` 比显示 `已清除 undefined 条` 更容易看出是缺陷。
 *
 * @param {string} template 带 `{0}` 占位符的中文模板
 * @param {...unknown} args
 * @returns {string}
 */
export function tpl(template, ...args) {
  if (typeof template !== 'string') return String(template);
  const pattern = locale === 'zh' ? template : DICT_EN[template] ?? template;
  return pattern.replace(/\{(\d+)\}/g, (whole, raw) => {
    const value = args[Number(raw)];
    return value === undefined ? whole : String(value);
  });
}
