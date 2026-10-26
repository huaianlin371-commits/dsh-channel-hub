# dsh-channel-hub

> **这是 [`dsh-providers-hub`](https://github.com/zhuweiyou/dsh-providers-hub)（MIT）的瘦身 fork。**
> 上游同时维护 20+ 个渠道，大多用不上；本 fork 用一道**渠道白名单**只保留 5 个，
> 并把它们的账号、积分、续期、网关继续做完。
>
> 📌 **只改「挂哪些渠道」，不改任一渠道的实现。** 白名单收口在两处：
> `src/llm-register-compat.ts` 的 `registerAdapterIdempotent()`（注册到
> `ctx.llm` 的唯一入口）与 `src/provider-registry.ts` 的 `isChannelAllowed()`。
> 要加回某个渠道，改 `ALLOWED_CHANNELS` 一行即可。

> **使用声明**：本项目仅供学习研究使用，请遵守各服务提供方的服务条款。

deepseek-harness 插件：统一管理多个 AI 编程服务的账号，并把它们的模型接进 DSH
的模型选择器。支持**多账号池**（同一服务登录多个账号，按可用性自动选号）与
**凭据静默续期**（到期前自动刷新，无需再次打开浏览器）。

- **5 个渠道**：CodeBuddy、WorkBuddy、Qoder 中国版、TRAE、Cline
- 登录、状态、续期、积分领取**全部在「大肥鱼饭碗」面板完成**，不注册任何斜杠命令
- 附带一个**本机 OpenAI 兼容网关**，供其它客户端复用已登录账号
- 界面支持**中 / 英切换**（面板右上角 `EN` / `中` 按钮）

> 📌 **本 README 只写「怎么用」。** 各 provider 的协议、端点、登录流程、请求头
> 构造、实测数据与事故史等**实现细节**，统一记录在不入库的内部文档
> `docs/implementation-notes.md` 中。需要改动实现或排查协议问题时读它。
>
> ⚠️ **accio 的章节该文件里还没有**（`implementation-notes.md` 目前零处 accio）——
> 读它时**不要**以为 accio 没有实现笔记。accio 的实测结论与坑点当前登记在
> `docs/agent-notes/providers-accio.md`（含三条与参考实现相反的结论、两个真缺陷、
> 区域选择与接线陷阱），补写 `implementation-notes.md` 的 accio 章节是**独立任务**。

---

## 目录

- [安装](#安装)
- [界面预览](#界面预览)
- [用法](#用法)
- [支持的渠道](#支持的渠道)
- [本机 OpenAI 网关](#本机-openai-网关)
- [用量徽标与 Token 用量](#用量徽标与-token-用量)
- [配置项](#配置项)
- [开发](#开发)

---

## 安装

该包尚未发布到 npm registry。提供两种安装方式。

### 方式一：从 git 仓库安装（推荐）

`add` 以 git 仓库方式安装（pnpm 内部走 `git+https:` 协议），会运行本包的 `prepare`
脚本自动构建 `lib/`，无需手动 `pnpm build`。

> ⚠️ **本机没装 git 时 pnpm 会直接失败**（`ERR_PNPM_GIT_FETCH_FAILED`，
> 提示 `'git' 不是内部或外部命令`）—— `github:` / `git+https:` 依赖都要 shell 出
> `git` 来解析。先装 [Git for Windows](https://git-scm.com/download/win) 再加。

⚠️ `prepare` **不依赖任何包管理器**（它直接内联 `tsc` / `node`）：pnpm 在 clone
目录里跑 `prepare` 时，**pnpm 10 / 11 不会把 npm 注入 PATH**（只有 pnpm ≥ 12 会）
⇒ 若 `prepare` 里写 `npm run …`，那两代上安装会直接失败。

⚠️ pnpm 10 起会拦截依赖的构建脚本，必须先在 profile 的 `pnpm-workspace.yaml`
（路径形如 `~/.dsh/profiles/<name>/pnpm-workspace.yaml`）里放行；而**放行键的写法
在 pnpm 10 与 pnpm 11 之间互不兼容**，写错就装不上。

**1. 先跑一次安装**（这一次必然失败，为的是让 pnpm 打印它期望的键）：

```sh
dsh plugin --profile <name> add "https://github.com/<your-account>/dsh-channel-hub.git"
```

**2. 按第 1 步的报错选一种写法，写进 profile 的 `pnpm-workspace.yaml`。**

报 **`ERR_PNPM_INVALID_VERSION_UNION`** 的（**pnpm 10.x**）—— 只认**纯包名**键：

```yaml
allowBuilds:
  dsh-channel-hub: true
```

报 **`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`** 的（**pnpm 11.x**）—— git 托管包
**不认**纯包名键，必须用第 1 步 pnpm 打印的**完整键（含 `#<commit>`）**：

```yaml
allowBuilds:
  dsh-channel-hub@git+https://github.com/<your-account>/dsh-channel-hub.git#<第 1 步打印的 commit>: true
```

**两代通用（省事，但放宽了权限）**：

```yaml
dangerouslyAllowAllBuilds: true
```

它会放行该 profile 里**所有**依赖的构建脚本（不止本插件）。

**3. 重跑第 1 步的命令**：这次会拉取、构建并安装成功。之后每次升级重新 `add` 即可。

⚠️ **不要**写 `dsh-channel-hub@git+https://gitee.com/…`（不带 `#<commit>`）——
这个"看起来最自然"的键在两代 pnpm 上都不工作。

⚠️ pnpm 11.x 的精确键里带 commit，因此**升级（重新 `add` 拉到新 commit）后该键
失效**，按新报错里的键替换即可；用 `dangerouslyAllowAllBuilds` 则不必改。

### 方式二：从源码目录安装（本地开发）

先在本仓库中构建 `lib/`，再安装为 pnpm `link:` 依赖：

```sh
pnpm build:all
dsh plugin --profile <name> install <path-to-this-repo>
```

> `dsh plugin install` 以 `link:` 方式安装，pnpm 不会为 `link:` 依赖运行
> `prepare` 脚本，因此必须先手动执行 `pnpm build:all` 生成 `lib/`。
> 注意必须用 `build:all` 而非 `build`：后者只编译宿主侧，不产出
> `lib/client/jet-hub.js`。

每次修改 `src/` 或 `plugin-src/` 后都需要重新执行 `pnpm build:all` —— dsh 启动时
不会自动重建。

### 通用说明

该包声明了 `dsh.bundle` 补丁（`cordis.patch.yml`），因此 profile 的 layer 栈会
自动拾取 `channel-hub` 行。插件注入由 dsh base 提供的 `credentials`、
`commands` 和 `llm` 服务。

---

## 界面预览

面板右上角是语言切换（`EN` / `中`），下面三张图分别是模型分组、Cline 订阅额度与
暗色下的用量徽标。

| 模型列表分组 | Cline 订阅额度 |
|---|---|
| ![模型列表分组](docs/images/jet-hub-model-list-grouping.png) | ![Cline 订阅额度](docs/images/jet-hub-cline-subscription-quota.png) |

![暗色下的用量徽标](docs/images/jet-hub-usage-badge-dark.png)

---

## 用法

**登录入口：「大肥鱼饭碗」设置页的对应 provider 面板。**

⚠️ **不注册任何斜杠命令** —— 登录、状态查看、续期与积分领取统一在 大肥鱼饭碗 完成。

基本流程：

1. 打开 大肥鱼饭碗（点主导航里的 **大肥鱼饭碗** 一行；也可从「设置 → 插件 → 大肥鱼饭碗」
   进入 —— 两条路径渲染的是**同一个页面**）；
2. 点「**+ 新建账号**」→ 浏览器打开授权页 → 完成登录；
3. 需要多个账号时重复第 2 步（账号池会自动选号）；
4. 回到 dsh 的模型选择器，选中该渠道的模型即可开始对话。

### 「面板入口」：两个入口二选一

上面那两条进入路径是**互斥**的，只能保留一条。改法在**插件详情页**：
「设置 → 插件 → dsh-channel-hub」，页面里有一张设置卡，卡里一个「**面板入口**」
下拉：

| 选项 | 结果 |
|---|---|
| **仅侧栏**（默认） | 主导航里多一行「大肥鱼饭碗」；设置弹层里**没有** 大肥鱼饭碗 那一节 |
| **仅设置页** | 只剩「设置 → 插件 → 大肥鱼饭碗」；主导航那一行消失 |

⚠️ 默认是「仅侧栏」，所以**设置弹层里默认找不到 大肥鱼饭碗 一节**，这不是插件没装好。
想从设置里进，就把下拉切成「仅设置页」——切换后主导航那一行会消失。

偏好存在宿主侧而不是浏览器存储，重启后保持 —— 理由见 `docs/agent-notes/client-ui.md`。

「+ 新建账号」是**两步式**的：先返回 `loginUrl` 由前端弹窗打开，后台再轮询换取
令牌 —— 这样不会阻塞浏览器手势窗口，弹窗不会被拦截。

账号卡片支持：**测试 / 重测 / 重置 / 停用 / 代理 / 指纹 / 删除**，以及拖拽排序
（**顺序即选号优先级**）。停用只影响自动选号，**不影响凭据续期与积分领取**。

⚠️ 「**代理**」按钮目前只对 `opencode` 与 `gemini` 渲染（两者语义不同，见
「出不去墙外服务」一节）；其余渠道的账号卡片上没有这个按钮。

---

## 支持的渠道

5 个 provider 路由，互不覆盖，可同时使用。

| id | 渠道 | 登录方式 | 积分能力 |
|---|---|---|---|
| `buddy` | CodeBuddy（腾讯） | 浏览器授权 + 轮询 | 余额 + 每日签到 + 成长任务 + 锁定永久积分 |
| `workbuddy` | WorkBuddy（国际版） | 同上 | 余额 + 锁定永久积分（**无签到**） |
| `qodercn` | Qoder 中国版 | 设备码轮询 | 余额 + 每日领取 |
| `trae` | TRAE（字节跳动） | 浏览器回调 | 余额 + 签到 |
| `cline` | Cline | WorkOS 设备码轮询 | 余额 |

> 另有 `jet-hub-auto`（**临期优先**的自动选号路由，不是渠道）：它跨这 5 个渠道按
> 积分到期时间挑号，不单独登录。上游的 `aggregate` 聚合路由本 fork **已移除**。

各渠道的能力与限制要点：

- **图片输入**：`buddy` / `workbuddy` / `trae`（逐模型）/ `minimax` / `minimaxintl`（部分模型）/
  `accio`（逐模型）支持；`lobsterai`、`zcode` **不支持**；其余以模型声明为准。
  ⚠️ `accio` 的图片通路**已于 2026-10-14 实测接通**（issue IKLR7V，上游原生收图
  `parts[].inline_data`，四色全对）；但它的 `multimodal: false` 模型**不报错、而是静默
  忽略图片**（会把答案**幻觉**出来），插件因此按**逐模型**声明模态（`false` 写 `['text']`），
  把这类模型挡在选择器之外。
- **思考档位**：多数渠道支持，档位名按各渠道自己的定义下发；未声明的渠道不发送该字段。
- **`loomy`** 是唯一用**短信验证码**登录、且**不能自动续期**的渠道。
- **`zcode`** 的领取路径需要一次性验证参数，由本机浏览器环境产出（web 版需要
  chromium，桌面版用自带内核）。
  ⚠ **推理（对话）路径是否也要它，由服务端开关决定**：官方 3.14.5 起
  `GET /api/v1/client/configs` 会下发 `captcha.skip_model_request`
  —— 当前实测是 `true`（**不校验**，故按最省的方式「先探后取」：
  不带验证头先发一发，被 `3007` 拒了才产）；一旦服务端翻成 `false`，
  插件会**自动改为首发直接带上**，不再白吃那发注定失败的往返
  （判据是三态：缺席 = 不知道 = 保持先探，见 `requiresCaptchaUpfront`）。
  ⚠️ **找不到浏览器时用 `ZCODE_CHROME_PATH` 指定**（Gitee issue IKQ4JN）：
  这是该链路**唯一**的人工出口，值是 chromium 内核浏览器的**绝对路径**
  （如 `C:\Program Files\Google\Chrome\Application\chrome.exe`）。
  候选链按优先级为 `ZCODE_CHROME_PATH` → `SCOOP` / `SCOOP_GLOBAL` →
  **从 `PATH` 反推的 scoop 根** → `~/scoop` → 系统 Chrome / Chromium /
  **Brave** / Edge。
  ⚠️ **设完必须重启 `dsh web`，且新进程要继承新环境** —— 从**旧终端**重启时
  新进程继承的仍是旧 shell 的环境快照，变量实际为空。找不到浏览器时的报错
  会回显「本进程看到的 `ZCODE_CHROME_PATH` = …」与**逐条候选路径**，
  照着它能立刻分清「变量没生效」与「路径写错」。
  ⚠️ **scoop 装在非默认根时不必设变量**：从 `PATH` 的 `<root>\shims` 反推
  已覆盖（用 `root_path` 把 scoop 挪到 D 盘的机器上 `SCOOP` 是空的，
  旧版因此一个 chromium 都找不到）。
  ⚠️ **不支持两类「看着能用」的封装**：Chrome++ 之类**外层 exe 启动后自行退出**
  （CDP 端口会正常起来，但退出码 0 被判为异常退出）；以及
  `chrome-headless-shell`（headless 一律 `F001`，必须 headful）。
- **`zcode` 的领取有「两个来源」，签到会同时查、一起去领**（2026-10-23）：
  ① 每日赠送 —— `GET /api/v1/zcode-plan/billing/preview` 的 `plans`；
  ② **营销活动投放** —— `GET /api/v1/marketing/touch` 里横幅按钮的
  `claim_zcode_plan`。后者就是官方客户端那类「限时可领取」横幅（如
  **1024 程序员节 5 亿 token**），它**不在** `preview` 里 —— 只查 preview 时
  它与「今天没有活动」在报文上**完全同形**（都是 `plans: []`）。
  ⚠️ **营销端点与领取端点都按客户端版本门控**：插件凭据里记的是自己的版本号
  （如 `3.14.3`）；用它查投放会拿到**空投放**，用它**领取**则回
  `400 / code 1004 no permission`（官方文案：「当前账号或**客户端版本**不满足
  领取条件」—— 极易被误读成「这个账号没资格」）。两条请求都会**按需抬到
  `3.16.3`**（`ZCODE_VERSION_GATED_MIN_APP_VERSION`；实测同一账号、其余头完全相同，
  只改这一个字段：查投放 `3.14.3` → `deliveries: []` / `3.16.3` → 有投放；
  领取 `3.14.3` → `1004` / `3.16.2` → `code 0`）。该覆盖**只作用于这两条请求**，
  不影响推理与额度两条已实测路径。
  ✅ **真机验收**（2026-10-23，走插件自己的生产路径）：`{"kind":"claimed",
  "credit":500000000,"unit":"token"}` —— 5 亿 token 领取成功。
  ⚠️ **「领取成功但额度仍是 0」是正常的**：活动的 `effective_at` 是 **23:00**
  （UTC+8），而额度桶要等那个时刻才建（上游 `plans[].status:"active"` 里
  额度已锁定，`balances` 仍是空的）。插件会把它单独显示成一个
  「**待生效**」的包并带出生效时刻，**不并进当前可用额度** ——
  并进去会让折算层在生效前就把 zcode 派发出去（必然失败）。
  ⚠️ **国际版（`zai`）账号同样能领到**（2026-10-23 实测：4 个账号含 2 个
  国际版都拿到同一个 1024 计划）⇒ 服务端**不按 OAuth 渠道区分**；
  「只有中国版有」是官方客户端**奖励中心分站**（`/cn/rewards` vs `/en/rewards`）
  造成的**入口**差异，插件不做渠道特判。
  ⚠️ 领取成功后插件会回报一次 `POST /marketing/touch/action`（`confirm`），
  否则服务端会**反复投放同一个活动** ⇒ 每轮签到白烧一个验证参数
  （阿里云验证是**设备级**配额）。失败时**绝不**回报 —— 那会让用户白丢一次机会。
- **`qoder` / `qodercn`** 共用同一套实现，差异仅在产品配置。
- **`minimax` / `minimaxintl`** 共用同一套实现（**唯一**的 Anthropic Messages
  协议族渠道），差异仅在产品配置。⚠️ 两站的**账号不互通、API 主机也不同**，
  故它们是**两个独立面板** —— 各自在自己的面板里点「+ 新建账号」即可，
  **无需选择站点**（`minimax` → `agent.minimax.cn`，`minimaxintl` → `agent.minimax.io`）。
  ✅ **国际版已完成真机验证**（2026-10-15）：登录、账号管理、模型目录、**推理**、
  **每日签到**、**积分查询**全部实测可用 —— 与国内站**协议同形**（认证同样只需
  `Authorization: Bearer`）。核验入口见 `tests/e2e/README.md` 的
  `test:e2e:minimaxintl`。
  ⚠️ 国际站的**目录端点当前是公开的**（无 token、垃圾 token 都 200）⇒
  「能看到模型列表」**不代表**凭据有效（凭据证据看签到 / 积分 / 推理）。
  ⚠️ 若国际站各端点**同时**报 `token is required` / `invalid signature`，
  请先怀疑**上游故障**而不是配置 —— 此时**官方 mcode 客户端也会同样失败**。
- **`gemini`（必须过墙，见「出不去墙外服务」一节）**：Google 的登录与接口全部
  在墙外。⚠️ 症状极具误导性：**浏览器能打开授权页并点「同意」，面板里账号却一直
  不出现** —— 因为**浏览器读系统代理、插件进程不读**。这不是 `client_secret` 或
  `redirect_uri` 配错（那个 bug 已被修掉，token 端点强制校验客户端身份）。
- **`accio`** 登录走浏览器回调。⚠️ **新建账号时必须先选登录区域**（中国版  `www.accio-ai.com` / 国际版 `zh.accio.com`）：两个区域的**登录页域名不同**，
  而区域由服务端按账号下发、**登录前无法自动判断** ⇒ 选错会打开打不开的登录页，
  **登录不会成功**。区域会写进凭据，续期与推理按它选域名。
  ⚠️ **它没有签到按钮** —— 每日积分由服务端在**登录时**发放（24 小时有效、
  **不累积**，未登录的那天不补），没有可调用的领取接口。面板上的积分按服务端下发的
  **三类桶**（每日 / 每月 / 推荐）分列显示，并给出每日额度的重置倒计时。
  ⚠️ **「刷新每日额度」入口尚未实现**：它本质是**重新登录既有账号**，
  需要宿主侧新增一条 RPC（现有的「+ 新建账号」每次都会新造账号，拿它重登只会
  多出一个空账号而原账号额度不变）。**当前要刷新请删除该账号后重新登录一次。**
  ⚠️ 模型**倍率跨度极大**（0.013 ~ 2.8，**215 倍**），故倍率直接写进模型展示名
  （`模型名 · x倍率`），选型时看名字即可。
  ⚠️ **图片输入未实测**，面板会明确报「暂不支持图片输入」而不是静默丢掉。
  ⚠️ **该渠道不产生限流标记**（也不会被限流探针测出东西），故「重测 / 重置」这组
  按钮对它**整组不渲染** —— 渲染出来只会是点不动的死控件。

### 一键领取积分

在对应面板标题栏点「**一键领取积分**」，插件会**顺序**处理该面板下的所有账号
（顺序执行以避免并发请求），并**逐账号显示结果与原因**。

⚠️ 汇总**按单位分列**，不跨量纲求和 —— `ZCode` 的额度单位是 **token**、其余渠道是
**积分**，两者不可折算，因此显示成 `+100.00MToken, +100积分` 而不是加成一个数。

### 模型列表开关

每个 provider 的面板都有「**显示列表**」按钮，可逐个开关模型，控制它是否出现在
对话框的模型选择器里（**黑名单制**，默认全部显示）。开关按 provider 隔离。

### 锁定永久积分

`buddy` / `workbuddy` / `loomy` 提供「**锁定永久积分**」按钮，用来保住不会马上
作废的积分。判定规则：距扣费截止不足 15 天的算**临时**（优先消耗），其余算永久。
锁定后只消耗临时积分，用完则明确报错而不是偷偷烧掉永久积分。

### 出不去墙外服务（`gemini`，以及任何需要代理的环境）

`gemini` 是本插件里**必须过墙**的渠道：令牌端点（`oauth2.googleapis.com/token`）、
userinfo、Cloud Code 的配额与推理端点（`cloudcode-pa.googleapis.com`）全部在墙外。

**典型症状**：浏览器**能**打开授权页并点「同意」，回到面板却一直失败、账号列表里
始终没有这个号；或账号在、但积分与对话全部失败。

**为什么浏览器能用、插件不能用**：浏览器读 **Windows 系统代理（WinINET）**，
而插件跑在 Node 的 `fetch`（undici）上，它**既不读系统代理、也不读
`HTTP(S)_PROXY`**。这条差异是全部症状的根源。

#### 两种配法（任选其一）

**① 给单个账号配出口代理（推荐）**

在 Gemini 面板的账号卡片上点「**代理**」→ 填地址（`http://127.0.0.1:7897` /
`socks5://…` / 带认证的 `http://user:pass@host:port`）→「测试连接」→ 保存。

- 「测试连接」**打的是 Google 自己的端点**（不是通用的出口 IP 查询服务）：
  代理能通 `ip-api` 却被 Google 拒的情况很常见，用后者会产生**假阳性**。
- 配好后该账号的**登录、续期、积分、对话**全部走这条出口，且**每个账号可以
  配不同的代理**。
- ⚠️ 该配置只作用于 Gemini（与 `opencode` 的「代理」是**两份独立配置**，
  清掉互不影响）。

**② 启动 dsh 之前导出环境变量**

```powershell
# PowerShell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:HTTP_PROXY  = 'http://127.0.0.1:7897'
$env:NO_PROXY    = 'localhost,127.0.0.1,::1'
dsh
```

⚠️ **必须「导出为环境变量」**。只打开系统代理开关（Windows 设置里的「使用代理
服务器」）**无效** —— 那正是浏览器能用、插件不能用的原因。

宿主 dsh 会在**第一个插件加载前**装一个全局代理分发器，所以这种配法对**插件的全部
请求**生效（不只 Gemini），也**不需要**额外设置 `NODE_USE_ENV_PROXY`。

#### Node 版本差异（2026-10-18 本机实测）

若走 ①（账号代理）不受此表影响 —— 它走插件自己的分发器，与 Node 版本无关。
下表说的是「裸 `fetch` 读环境变量」那条路：

| Node | 仅设 `HTTPS_PROXY` | 再加 `NODE_USE_ENV_PROXY=1` |
|---|---|---|
| 22.19 | ❌ 不读 | ❌ 不读 |
| 24.21 | ❌ 不读 | ⚠️ 读，但失败后会反复重试，界面长时间无响应 |
| 26.10 | ❌ 不读 | ✅ 可用 |

⇒ **结论**：这条「绕过」的路只在较新的 Node 上干净。优先用 ①。

#### 报错文案

连不上时，插件会明确提示「疑似需要代理」并带上根因码（如
`UND_ERR_CONNECT_TIMEOUT`），登录失败、续期失败、积分查询失败与对话失败四条腿
都会给同一句指路文案 —— 不再是一句无信息量的 `fetch failed`。

⚠️ 代理恢复后**无需重登**：凭据没被标成失效，后台续期会照常在下一轮把它接上。

---

## 本机 OpenAI 网关

插件启动后会在 `127.0.0.1:8326` 提供**两套**标准 OpenAI 接口，供 Pi、Continue、
Cline、OpenCode、Codex 或其他兼容客户端使用。网关复用 大肥鱼饭碗 已登录账号和现有
provider 适配器，不把上游凭据复制到客户端。

```
GET  http://127.0.0.1:8326/v1/models
GET  http://127.0.0.1:8326/v1/reasoning-efforts   ← 思考档位对照表
POST http://127.0.0.1:8326/v1/chat/completions    ← OpenAI Chat Completions
POST http://127.0.0.1:8326/v1/responses           ← OpenAI Responses API
```

⚠️ **两个端点同时可用，没有「格式开关」**：客户端用哪一套协议，由它自己请求的
路径决定。

⚠️ 上面那两个地址里的 **host 与端口都可被环境变量改掉**
（`DSH_OPENAI_GATEWAY_HOST` / `DSH_OPENAI_GATEWAY_PORT`）；设置页里的
「API 请求地址」显示的是**实际监听地址**，照它抄即可。

### 容器化部署（Docker / Compose）

默认只绑 `127.0.0.1`，因此**端口映射对网关无效**：容器里 `curl 127.0.0.1:8326`
能通只是假象，docker-proxy 与同网络的其它容器走的是容器桥接 IP（`eth0`），
那个地址上没有监听，于是宿主侧看到 `Connection reset by peer`
（对照：Web 端口绑的是容器 IP，所以映射可用）。

修法是让网关绑**容器自身的接口地址**：

```yaml
environment:
  - DSH_OPENAI_GATEWAY_ENABLED=1
  - DSH_OPENAI_GATEWAY_HOST=172.21.0.8   # 容器自身 IP：hostname -i 或 ip -4 addr show eth0
  - DSH_OPENAI_GATEWAY_PORT=8326
```

```console
$ docker exec dsh ss -tlnp | grep 8326
LISTEN  172.21.0.8:8326     # 绑上桥接 IP 后，端口映射才可达
```

⚠️ **不许填 `0.0.0.0` / `::` 这类通配地址**：会被显式拒绝并在启动前报错
（dsh 本体的 `--host` 也是同一姿态）。绑通配等于把网关暴露给整个网络，
真正的隔离只剩 API Key —— 而本网关承担的是「用你已登录的账号发请求」。
容器场景填容器自身 IP 即可。

⚠️ **暴露面不止「同一容器网络内的其它容器」，还包括宿主**：经端口映射（`-p`）
或 bridge 网关，宿主本身就能连到该端口。跨 bridge 网络的容器才被隔离。
设置页里绑了非回环地址时会显示这条提示；不打算对外提供时请保持默认
`127.0.0.1`（或删除该环境变量）。

### 拿到地址与密钥

鉴权使用 `Authorization: Bearer <网关 API Key>`。

⚠️ 因此**在浏览器地址栏直接打开这些地址会返回 401**（没有带 Bearer 头）——
这是预期行为，不是网关没启动。请用客户端或 `curl` 带上传头访问。

优先从 `DSH_OPENAI_GATEWAY_API_KEY` 读取；未设置时，插件首次启动会在 DSH home 的
`openai-gateway/api-key` 生成并持久化随机密钥，重启后保持不变。

设置页里的开关状态存在 `$DSH_HOME/jet-hub/state.json` 的 `gatewayEnabled` 字段
（缺省为启用）。它**不进**账号备份/恢复。

### 关闭网关

网关是**旁路功能**：它启动失败或被关闭，都不影响插件其余功能（登录、积分、模型
目录照常）。三种关闭方式：

| 方式 | 做法 |
|---|---|
| 环境变量 | `DSH_OPENAI_GATEWAY_ENABLED=0`（**完全不启动**，连 API Key 文件都不生成）|
| 设置页开关 | 关掉后不再监听 |
| 改端口 | `DSH_OPENAI_GATEWAY_PORT` 填非法值会记录错误并跳过启动，**不会**静默改用其它端口 |
| 改地址 | `DSH_OPENAI_GATEWAY_HOST` 填通配地址（`0.0.0.0` / `::`）同样记录错误并跳过启动 —— **不会**静默绑到全部网卡 |

### 请求体上限与 keep-alive

| 项 | 值 | 超限时的行为 |
|---|---|---|
| 请求体 | **300 MiB** | `HTTP 413` + `invalid_request_error` / `request_too_large`，响应体里带上限值 |
| 空闲连接（keep-alive） | **120 秒** | 服务端发 FIN；此后复用该连接会得到 `Connection reset` |

⚠️ 每轮把全量历史重新回传的客户端（Codex 等），历史里并入大截图后可能撞上 413：
新建会话、或删掉那条带大图的回合即可恢复。

### 安全边界

- **默认**只绑定 `127.0.0.1`，且**拒绝**通配地址（`0.0.0.0` / `::`）。
  只有容器/端口映射这类「客户端不在同一网络命名空间」的场景才需要改
  `DSH_OPENAI_GATEWAY_HOST`，且应填**具体接口地址**（如容器自身 IP）而不是通配。
  ⚠️ 改了之后暴露面**包含宿主**（端口映射/bridge 网关都能连到），
  同机与同容器网络的其它用户或进程也能连到该端口 —— 真正的隔离靠 API Key，
  不要把它配置进任何浏览器端工具或扩展。
- 密钥以明文写在 `$DSH_HOME/openai-gateway/api-key`。POSIX 下的 `0600` 权限在
  **Windows 上不生效**，多用户机器请改用 `DSH_OPENAI_GATEWAY_API_KEY` 环境变量。

---

## 用量徽标与 Token 用量

### 用量徽标

会话输入区右侧、模型选择器左边有一枚薄胶囊，显示**当前渠道一共有多少可用额度**；
点开是完整浮层（逐账号明细 / 订阅窗口 / 刷新 / 签到 / 显示偏好）。
只在选中本插件渠道的模型时渲染，非本插件的模型**不渲染、不发请求**。

折叠态按 **`渠道 • 读数`** 两段显示，例如：

```
CodeBuddy (腾讯) • 2434.96积分
CodeArts (华为云) • 9499.84积分
ZCode (智谱) • 94.54MToken
```

- **默认显示余额**（一共能用的额度）；可在浮层里切换成「优先订阅」或「只看积分」。
- **多账号只显示一个数字**（所有启用账号的余额合计），不会变成一长串。
- 账号读不到时合计会**静默少报**，故胶囊会挂一个**警示角标**（`441.78积分 ⚠`）。
- 浮层里逐账号列表**按余额降序**，超过 5 个折叠成「展开其余 N 个」。

### Token 用量

点 大肥鱼饭碗 页头的「**Token 用量**」按钮查看。数据分两份：

| 数据 | 位置 | 回答的问题 | 重启后 |
|---|---|---|---|
| 实时明细 + 汇总树 | 进程内存（上限 500 条） | 每一笔长什么样、这次会话花了多少 | 清空 |
| 历史日聚合 | `~/.dsh/jet-hub/token-ledger.json` | 本周 / 本月用了多少 | **保留**（按 UTC+8 日界，90 天）|

在历史图表中点选某一天并展开，可删除该日的历史累计。删除前会二次确认，只移除该日聚合，不影响实时明细、其他日期或账号设置；之后该日的新请求会重新累计。

- **计数是 wire 口径**：上游 usage 报什么记什么，不做本地估算。
- **总处理量** = 未命中缓存输入 + 缓存命中输入 + 输出；输出已含思考 token，缓存写入另列且不重复计入。不同渠道价格不同，因此这里不把 token 数冒充账单金额。
- 没收到 usage（失败 / 中断）显示 `—`，与真实的 `0` **严格区分**。
- 输出速率（tok/s）的分子含思考 token；汇总显示算术均值及完整样本的 P50/P90 估值。
- 日聚合文件升级到 schema v2 增加 TPS 对数直方图；旧 v1 数据照常读取（计数全保留）。⚠️ **升级前已累计过「输出速率样本」的日期不会显示 P50/P90** —— 判据要求「直方图样本数 = 累计样本数」，而旧桶的 `tpsCount` 在升级前就已累加、直方图为空，两者之差恒定 ⇒ 该日期在 90 天保留期内一直无分位数（`avgTps` 均值仍照常显示）。完全在 v2 之后累计满样本的日期正常显示；升级前存在但**从未有过速率样本**的日期（如当天全是失败请求）也会正常显示。

---

## 配置项

| 项 | 位置 | 说明 |
|---|---|---|
| 账号池 | `$DSH_HOME/jet-hub/state.json` | 账号、有效期、限流标记、模型黑名单、provider 顺序 |
| 网关开关 | 同上，`gatewayEnabled` | 缺省启用 |
| 供应商显示顺序 | 同上，`providerOrder` | 纯展示偏好，拖动行调整 |
| 永久积分锁定 | `$DSH_HOME/jet-hub/*.json`（独立文档）| **不与账号池同放** —— 避免多 profile 互相覆盖 |
| Token 账本 | `~/.dsh/jet-hub/token-ledger.json` | 历史日聚合 |

### 常见环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` | 关闭 | 设为真值时，**没有已登录账号的渠道**在模型选择器里整体隐藏 |
| `DSH_OPENAI_GATEWAY_ENABLED` | `1` | 设为 `0` / `false` / `off` / `no` 时完全不启动网关 |
| `DSH_OPENAI_GATEWAY_HOST` | `127.0.0.1` | 网关监听地址。容器/端口映射场景填**容器自身 IP**（`hostname -i`）；填 `0.0.0.0` / `::` 等通配地址会被拒绝并跳过启动 |
| `DSH_OPENAI_GATEWAY_PORT` | `8326` | 网关监听端口 |
| `DSH_OPENAI_GATEWAY_API_KEY` | 自动生成 | 网关 Bearer 密钥 |
| `DSH_REASONING_LOOP_GUARD` | 开启 | 思考死循环守卫总开关 |
| `DSH_REASONING_LOOP_AUTO_RESUME` | 开启 | 中止后是否自动补一句「继续」并重跑 |
| `DSH_REASONING_LOOP_AUTO_RESUME_MAX` | `2` | 连续自动续跑上限（最大 `10`）|| `DSH_TRAE_CHANNELS` | `solo_work_lite,solo_agent_remote` | TRAE 要拉取的通道，**顺序即优先级** |
| `DSH_TRAE_MAX_COMPLETION_TOKENS` | `64000` | TRAE 单次输出上限（设 `0` 关闭收敛）|

更多 provider 专属变量（如 `DSH_ZCODE_INTERNAL_CARRIER`、
`DSH_TRAE_ROTATE_MACHINE_ID` 等）见内部文档。

---

## 账号备份与迁移

「大肥鱼饭碗」设置页底部的**备份**区提供导出 / 导入，用于两种情况：**换 DSH 版本时整体迁移**，
以及**从别处单独搬一个账号进来**。

备份文件是**自包含**的 JSON（账号索引 + 凭据原文 + 模型黑名单 + 永久积分锁定表），
与 DSH 版本无关 —— 导入时按**当前版本**的存储契约重建，因此天然跨版本。

- **加密在浏览器侧完成**（PBKDF2 + AES-GCM），RPC 只收发明文载荷，明文与口令
  都不经过宿主持久化与日志。可选加密，不勾选即导出明文。
- 账号凭据、`refresh_token` 都在文件里，**等同于明文密钥**，请自行妥善保管。
- ⚠️ **不含的就是本机偏好**：备份只搬账号与凭据，**不搬**本机 OpenAI 网关开关、
  用量徽标偏好、自动签到记账等本机状态（导入时它们保持当前值，不会被备份覆盖）。
  账号条目上的字段（含 OpenCode 的 `opencodeProxy` / 指纹代次，以及 Gemini 的
  `geminiProxy`）则原样随快照往返。

### 导出：可以只导出选中的账号

导出弹窗列出当前账号池并可**逐个勾选**（`backup.export` 的 `accountIds`），
默认「全部账号」。只导一个账号时文件名会带上该账号 id（`dsh-codearts-backup-buddy-xxxx-日期.json`），
避免被误当成整份备份收着。

⚠️ **过滤只作用于 `accounts` 与 `credentials` 两个字段**：模型黑名单与永久积分锁定表
仍按**全量**写出。这样「只导一个账号」的产物依旧是**一份可整体还原的自包含快照** ——
让过滤只承担一种语义，两条路径就不会互相污染。

### 导入：两种模式（`replace` / `merge`）

| 模式 | 语义 | 用于 |
|---|---|---|
| `replace`（默认） | **整体替换**账号池与模型黑名单，还原快照 | 「恢复」按钮、换 DSH 版本后整体迁移 |
| `merge` | **只追加**：已存在的账号一律跳过，**不碰**模型黑名单与锁定表 | 「单独导入一个账号」、从别人的备份里挑账号 |

导入弹窗可勾选要落地哪些账号，并选择模式。

⚠️ **`merge` 下裁剪发生在发请求之前**（`plugin-src/client/backup-payload.js`）。
判重虽然在后端，但后端只知道「这份载荷里有哪些账号」，不知道用户勾了哪几个；
不先裁剪的话，从整份备份里只勾一个账号，其余账号仍会被追加，更糟的是备份里那些
**不在勾选范围内**的 `credentialRef` 可能已被本机现有账号占用，写进去等于
**覆盖现有账号的凭据**，与「只增加不覆盖」的承诺相反。故裁剪必须同时裁掉
`accounts`、`credentials` 与 `disabledModels` 三处。

### ⚠️ 合并导入判重的三层口径（缺一层就会堆出重复账号）

`src/backup.ts` 的 `importBackup({ mode: 'merge' })` 依次判：

1. **池里已有的 `id`** —— 账号的唯一键；
2. **池里已有的身份**（`provider:` + 凭据里的身份字段，见下表）；
3. **备份文件内部重复的 `id`** —— 同一份文件手工编辑后可能出现两条同 id。

⚠️ **只按 `id` 判重是不够的，第 2 层才是关键**：插件自己登录时 `id` 由 `shortId()`
**随机**生成（`buddy-a1b2c3d4`），而从第三方文件转换来的 id 是**确定性哈希**
（见下节）。同一个人因此有两套 id，只比 id 会把他重复加进池里 —— 而用户在
「从别人的备份里挑账号」时，最常见的情形恰恰是「这个号我已经手登过了」。

⚠️ **身份字段逐 provider 对齐**（漏一个字段，那个 provider 的「同一个号我已手登过」
场景就**必然**多一条重复账号）：

| 字段 | 哪些 provider 的凭据里有 |
|---|---|
| `user_id` | CodeBuddy / WorkBuddy / LobsterAI / Raccoon / ZCode |
| `uid` | Qoder（含中国版）/ TRAE |
| `userid` | Loomy |
| `account_id` | Cline / MiniMax |
| `sub` | Gemini（OIDC `sub`；**不取 `email`** —— 它会随改邮箱而变） |
| `api_key` | OpenCode（**仅账号槽**） |

⚠️ **Gemini 只认 `sub`，不认 `email`**：两者都在它的凭据里，但 `sub` 是 OIDC 的
**稳定主体标识**（换邮箱、改昵称都不变，上游就拿它当账号 id），而 `email` 会随用户
改邮箱而变 —— 拿它判重会让同一个账号在改邮箱后多出一条重复账号。

⚠️ **OpenCode 的匿名通道要排除**：它的凭据只有 `api_key`，而匿名通道的 `api_key`
恒为字面量 `public` —— 全部匿名槽共用一个值。若拿它当身份，用户刻意添加的
**第二条匿名通道会被判成「已存在」而拒绝导入**（「多条匿名通道各走各的出口」
是上游明确提供的能力）。故匿名槽不产生身份，退回按 `id` 判重。

⚠️ **轮换令牌（`access_token` / `refresh_token`）不能当身份**：它们每次续期都会变，
拿来判重会让续期后的同一账号被判成新账号。

⚠️ **`id` 与身份都可能判不出来**：凭据缺失/损坏时按「无法判断」跳过该条，
不让一次判重失败阻断整体导入。

### ⚠️ 第三方账号列表可以直接导入（自动转换）

很多用户手上的是**别的工具**（账号池 / 卡号池脚本、IDE 本地缓存导出）产生的
CodeBuddy 账号列表，而不是本插件备份。两者结构完全不同：

| | 第三方账号列表 | 本插件备份 |
|---|---|---|
| 顶层 | **裸数组** `[ {...} ]`（或 `{ accounts / data / items / list: [...] }`） | 对象 `{ format, version, ... }` |
| 格式标记 | 无 | `format: 'dsh-codearts-auth/backup'`（**历史值，勿改**：改了就读不了老备份） |
| 凭据 | 账号对象里**直接带** `access_token` / `refresh_token` | 独立 `credentials` 字典（ref → 凭据 JSON **原文字符串**） |
| 账号索引 | `id` 是 uid 或工具自己的编号 | `accounts[]`，`id` 形如 `buddy-a1b2c3d4` |

直接把它丢给「恢复」只会得到「该备份文件里没有账号」—— 因为取不到 `accounts`。
故选中这类文件时会**自动识别并转换**（`plugin-src/client/backup-convert.js`），
转换结果显示在弹窗里供核对，并**默认落到 `merge` 模式**（别人的新号，避免误覆盖本机账号）。

⚠️ **转换只改结构，不改写令牌**：`access_token` / `refresh_token` 原样搬运。
其余字段以「本机一个真实可用的 CodeBuddy 凭据」为基准对齐：

| 字段 | 来源 |
|---|---|
| `expires_at` | 原值（**毫秒**时间戳），统一成字符串毫秒 |
| `refresh_expires_at` | 优先 `auth_raw` 的 `refreshExpiresIn - expiresIn` 差值补算，退回 refresh_token 的 JWT `exp` |
| `domain` | **access_token 的 JWT `iss` 主机名**（它会被当作 `X-Domain` 头发出去） |
| `user_id` | access_token 的 JWT `sub` |
| `token_type` / `account_type` | 原值，缺省 `Bearer` / `personal` |
| `enterprise_id` | 缺省 `''`（个人版为空串，与真实凭据一致） |

⚠️ **provider 按 JWT `iss` 的主机名分派**：含 `workbuddy` → 国际版，否则 → `buddy`。
两套 provider 是**不同路由**，认错会让凭据发到错误的端点。

⚠️ **账号 id 由 uid 经 FNV-1a 哈希确定性生成**（`stableShortId`），与插件自己登录
生成的形式一致。这样**同一份文件导入两次，第二次会全部被判为「已存在」而跳过**，
而不是堆出两份账号。但 id 判重挡不住「同一个人的账号已用随机 id 登录在本机」——
那正是靠上文第 2 层的身份字段判重。

⚠️ **不写 `scope`**：真实凭据里有它，但插件**从不读取** `scope` 发请求
（只在续期时原样带回），而第三方文件里也没有 —— 与其猜一个可能不准的值，不如省略。

### ⚠️ 合并导入只写「真正要新增的账号」的凭据

`merge` 模式下**绝不回写备份里其余凭据**（含各 provider 的默认单凭据 ref）。
`replace` 模式才按字典逐条写入 —— 备份文件里可能含账号池之外的独立凭据 ref，
导出时一并纳入，导入时同样还原。

⚠️ 写入顺序是**先凭据、后账号池**：账号池写入成功后门控（`hasLoggedInAccount`）
与黑名单立即反映新状态；凭据写入中途失败（非法 ref 等）只跳过该条、不中断整体。

⚠️ **模式必须取白名单**（`req?.mode === 'merge' ? 'merge' : 'replace'`），
不能把请求里的任意字符串透传下去：未知值会被 `?? 'replace'` 静默当成整体替换 ——
那时用户以为只是「加一个账号」，实际账号池被清空，属于**不可逆的数据损失**。

### 测试

- `tests/unit/backup.spec.ts`（44 条）—— 选择性导出、合并导入三层判重、
  `merge` 不回写其余凭据、`replace` 兼容旧行为、各 provider 的身份字段覆盖度；
- `tests/unit/backup-payload.spec.ts`（13 条）—— 载荷裁剪与账号摘要；
- `tests/unit/backup-convert.spec.ts`（28 条）—— 第三方列表识别与转换；
- `tests/unit/account-pool.spec.ts` 的 `mergeAccounts` 段（6 条）—— 只追加、
  不改黑名单与锁定、坏条目归一化、文件内重复 id。

### ⚠️ 与上游同步（2026-10-02）

本章功能已随上游 62 个提交（新增 OpenCode provider、本机 OpenAI 网关、用量徽标、
自动签到、供应商开关）重新落地：只有 `plugin-src/client/jet-hub.js` 的 import 块
需要手工合并，`BackupPanel` 与 `src/backup.ts` 上游未改动。唯一的适配点是
**OpenCode 的身份字段**（见上表与匿名槽说明）。细节与反向验证记录见 `AGENTS.md`
的「上游同步记录」一节。

⚠️ 已做**反向验证**（2026-09-30）：禁用身份判重 → 1 条变红；让 `merge` 回写全部
凭据 → 3 条变红；`mergeAccounts` 去掉文件内去重 → 1 条变红。

## 开发

> **本 fork 与上游的差异只有一处：`ALLOWED_CHANNELS` 白名单。**
>
> - `src/provider-registry.ts`：`export const ALLOWED_CHANNELS` 定义保留哪 5 个渠道；
>   `isChannelAllowed(id)` 是唯一判据（`channel: false` 的非渠道项恒保留）。
> - `src/llm-register-compat.ts`：`registerAdapterIdempotent()` 在调
>   `llm.registerAdapter()` 之前按白名单过滤 `providers`。⚠️ 它**仍返回适配器实例**
>   （白名单内一个都没有时返回 `target` 而不是 `undefined`）—— `apply()` 阶段有代码
>   直接调 `adapter.setCaptchaConfig()` / `adapter.stop()`，返回 `undefined` 会崩。
> - `src/index.ts`：`modelAdaptersAll` → `modelAdapters`（按白名单过滤）与
>   `registry` 续期循环。逻辑上的 `aggregate` 聚合路由已整块移除。
>
> 要把某个渠道加回来：改 `ALLOWED_CHANNELS` 一行，再跑
> `tests/unit/provider-registry.spec.ts` 与全量测试即可。
>
> ⚠️ `tests/unit/` 里有一批用例**硬编码了全量渠道名单**（如 `AUTH_SERVICE_OF`）。
> 本 fork 用 `tests/unit/_channel-whitelist.ts` 提供的 `allowedIds()` / `allowedOnly()`
> / `allowedIt()` 把断言改成**跟随白名单现算**，而不是删掉用例 —— 将来加回渠道时
> 这些断言会自动覆盖它。

```sh
pnpm test          # 单元测试（快速，无网络，全部 mock）
pnpm typecheck     # 只做类型检查
pnpm build:all     # 完整构建（宿主 tsc + 资源拷贝 + 客户端 esbuild）
```

### 构建

- `pnpm build` — 用 tsc 将 `src/` 编译到 `lib/`。插件**宿主侧**入口是 `lib/index.js`。
- `pnpm build:client` — 用 esbuild 将 `plugin-src/client/` 打包为
  `lib/client/jet-hub.js`（「大肥鱼饭碗」设置页的客户端 bundle）。
- `pnpm build:all` — 依次执行上述步骤（**含 `build:assets`**：把 `src/qoder-auth-wasm.wasm` 复制到 `lib/`，`tsc` 不搬 `.wasm`，而 `package.json` 的 `files` 只发布 `lib/`）。
- `pnpm typecheck` — 只做类型检查，不产出文件。

`lib/` 已被 gitignore，因此构建是安装或运行前的必需步骤。

### E2E 测试

E2E 探针**按 provider 分列**（如 `pnpm test:e2e:codearts`、`pnpm test:e2e:buddy`、
`pnpm test:e2e:loomy`），**均有闸门、默认全部跳过** —— 需要显式设置对应环境变量
（部分还需 `..._CONFIRM=yes`）才会真正发出请求。详见 `tests/e2e/README.md`。

⚠️ 带 `-claim` / `-chat` / `-tools` 后缀的探针会**真实消耗额度或领取机会**；
带 `-refresh` 后缀的会**真实轮换一次凭据**（如 `accio-refresh`）。运行前请确认。

### 项目结构

| 路径 | 说明 |
|---|---|
| `src/` | TypeScript 源码（宿主侧） |
| `plugin-src/client/` | 「大肥鱼饭碗」客户端源码（esbuild 打包） |
| `lib/` | 编译产物（已 gitignore） |
| `tests/unit/` | 单元测试 |
| `tests/e2e/` | 端到端测试（默认跳过） |
| `docs/agent-notes/` | 逐 provider 的事故史与约定（开发向） |
| `docs/implementation-notes.md` | **全部实现细节与协议笔记（不入库）**。⚠️ **目前没有 accio 章节** —— accio 的实测笔记在 `docs/agent-notes/providers-accio.md`，补写该章节是独立任务 |
| `cordis.patch.yml` | DSH bundle 补丁 |
