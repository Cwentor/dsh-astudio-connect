# dsh-astudio-connect

[English](./README.en.md) | 中文

将 AStudio 应用中已登录的模型接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)，零配置使用。
Bring the models signed in to the AStudio desktop app into DeepSeek Harness with zero configuration.

参考 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 的设计思路，针对 AStudio 的 maas-api（标准 OpenAI 协议）大幅精简。

> **零配置**：复用你本机 AStudio 的登录凭证，不重新登录，不落盘。

## 目录

- [安装](#安装)
- [功能](#功能)
- [命令行](#命令行)
- [工作原理](#工作原理)
- [配置](#配置)
- [模型目录](#模型目录)
- [推理档位与探测](#推理档位与探测)
- [模型显隐](#模型显隐)
- [积分余额徽标](#积分余额徽标)
- [设置卡片](#设置卡片)
- [更新检查与主机心跳](#更新检查与主机心跳)
- [位置发现（Windows）](#位置发现windows)
- [DSH 版本支持](#dsh-版本支持)
- [已知限制](#已知限制)
- [安全说明](#安全说明)
- [开发](#开发)
- [免责声明](#免责声明)
- [相关项目 / 社区生态](#相关项目--社区生态)
- [致谢](#致谢)
- [许可证](#许可证)

## 安装

### 前置

- 本机已安装 Node.js `^22.19.0 || >=24.0.0`
- 本机已安装并登录 AStudio 桌面应用（插件直接复用 App 的登录状态，账号切换自动跟随）
- DeepSeek Harness 运行时，版本要求见 [DSH 版本支持](#dsh-版本支持)

### 安装插件

插件通过 `cordis.patch.yml` 注册插件清单，DSH 启动时自动加载。

```bash
# 从本地目录安装
npm install -D ./dsh-astudio-connect
```

或在 DSH 插件管理器中添加本目录路径。

### 验证

装完必须**完全退出并重启 DSH**（DSH 在启动时加载插件，仅刷新页面不够），然后确认：

1. 模型选择器里出现 **AStudio** 分组；
2. 从分组里选一个模型，完成一次简短对话并能正常回复。

两条都满足才算安装成功。若分组不出现，先用 [命令行](#命令行) 的 `doctor` 看登录态与配置路径。

> 也可以把安装交给本机已有的 Agent（DSH Agent、Codex、Claude Code、Cursor 等），把下面这段话原样发给它：
>
> 请帮我安装并验证 DSH（DeepSeek Harness）插件 dsh-astudio-connect（本地目录：`<本仓库路径>`）：
> 先阅读项目 README，确认我实际使用的界面（Web / Desktop / TUI）与 DSH 内核版本；
> 按 `cordis.patch.yml` 的注册方式从本地目录安装，不要改依赖包或绕过宿主校验；
> 任何本地文件或配置改动，先征得我同意并做好备份；
> 装完后验证模型选择器里出现 AStudio 分组，并陪我完成一次简短对话。

## 功能

- **开箱即用**：安装并启用插件后即可在 DSH 中直接使用，无需额外配置。
- **凭证复用**：读取 AStudio 的 `experimental_bearer_token`，无需额外 OAuth 流程。
- **标准协议**：maas-api 是标准 OpenAI 兼容协议，pi-ai 原生支持，无需协议转换。
- **全能力桥接**：非流式、流式 SSE、工具调用、推理模型的 `reasoning_content`、上下文压缩，全部沿用 DSH 宿主自己的实现。
- **模型目录**：取自 AStudio 自己的 model-manager 接口（即 AStudio 界面渲染的那份文档），带真实的上下文窗口与最大输出，并支持「实时 → 已保存 → 内置」三级降级。
- **推理档位探测**：对未声明档位的模型，由你主动授权后发送带哨兵的最小请求，确认上游真的校验 `reasoning_effort`，再逐项确认接受哪些档位。
- **模型显隐**：在设置卡片里勾选要在选择器中显示的模型，按登录账号分别保存；隐藏只影响可选性，不影响正在使用该模型的已有会话。
- **余额速览**：选中 AStudio 模型时，输入框模型选择器旁显示账户的通用 / 星火两份积分余额，右侧 ↻ 手动刷新，不自动轮询。
- **设置卡片**：侧栏「插件」面板下的 AStudio Connect 卡片，分「账户 / 上下文 / 探测」三个分区，可手动刷新目录与探测。
- **命令行诊断**：`status` / `doctor` / `logout` 三个命令，全程不输出 token 材料。
- **更新检查**：对照 npm 公共 dist-tags 判断是否有新版本，并用 GitHub releases 补充说明。

## 命令行

插件自带一个 `dsh-astudio-connect` 可执行文件（`package.json` 的 `bin`）。它**不启动宿主、不加载 pi-ai**，因此可以独立运行、随处排查问题：

```
Usage: dsh-astudio-connect <doctor|status|logout> [--provider astudio] [--json]

  doctor   secret-free sign-in and environment diagnostics
  status   sign-in state, catalog source, and model count
  logout   clear the plugin in-memory credential cache

  --provider  which provider to inspect; defaults to astudio
  --json      emit one secret-free JSON document (doctor/status only)
```

从仓库本地运行（未全局安装时）：

```bash
node lib/bin.js status
node lib/bin.js doctor --json
node lib/bin.js logout
```

| 命令 | 输出 | 退出码 |
|---|---|---|
| `doctor` | 配置文件路径与存在性、登录态、model-manager 令牌是否存在、修复提示 | `signed-in` 且配置文件存在时为 `0`，否则 `1` |
| `status` | 登录态、目录来源、模型数 | `signed-in` 时为 `0`，否则 `1` |
| `logout` | 清除插件自留的内存凭证缓存 | 恒为 `0` |

行为约定：

- **不写任何东西**：三个命令都不会写 AStudio 的 `config.toml`；`logout` 只清插件自己的内存缓存，不动桌面 App 的登录，也不承诺让模型分组消失（App 的凭据文件仍在时依然生效）。
- **不回显凭据**：输出里只有 `tokenLength` 和「是否存在」，从不打印 token 本体；异常信息里形如 JWT 的串会被替换成 `[redacted token]`。
- **`--provider` 只接受 `astudio`**，传别的值直接报错退出。

> **已知行为**：`status` 报告的目录来源恒为「内置」。实时刷新发生在宿主进程内，独立的 CLI 进程不会发起那次请求，因此它只反映内置清单，不代表宿主当前实际使用的目录。要看宿主的真实来源，请看设置卡片的「账户」分区。

## 工作原理

插件通过三层桥接把 maas-api 的模型注册进 DSH 的 `llm` seam：

1. **凭证层**（`auth.ts`）：读取 AStudio `config.toml` 中的 `experimental_bearer_token`，内存缓存，不落盘。
2. **本地 shim**（`shim.ts`）：在 `127.0.0.1` 上启动 OpenAI 兼容端点，经过四重入站校验后，将请求转发到 maas-api。
3. **pi-ai 适配**（`adapter.ts`）：用 `openAICompletionsApi()` + `PiAiAdapter` 把 shim 的端点注册为 DSH 的 `astudio` provider。

```
DSH (llm seam) → AStudioPiAiAdapter → 127.0.0.1 shim → maas-api (Bearer token)
```

模型目录与积分余额走另外两条只读路径，都不经过 shim：

```
model-manager API ← modelBearerToken（模型清单与上下文参数）
账户积分 API     ← ssoSessionId（通用 / 星火积分余额）
```

这三份凭据都来自 AStudio 自己的文件，但用途不同、互不通用。

### shim 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | 存活探针 |
| `GET` | `/v1/models` | 模型清单，**已过滤隐藏项** |
| `POST` | `/v1/chat/completions` | 转发到 maas-api，透传请求体与流式响应 |

请求体上限 64 MB；流中断时补发 `data: [DONE]\n\n`；单次流空闲上限 300 秒。

shim 绑定的端口会避开 fetch 标准禁止连接的端口（`loopback.ts` 的 `FETCH_BLOCKED_PORTS`）：操作系统可能分到一个 fetch 拒连的临时端口，那样 shim 虽然监听成功、但每次请求都会以 `TypeError: fetch failed` 失败，所以绑定后会重新尝试，最多 16 次。

## 配置

插件配置通过 DSH 的插件页管理（0.2.x 在侧栏「插件」面板 → AStudio Connect）：

| 字段 | 说明 |
|------|------|
| `displayName` | 模型选择器中显示的 provider 名称（默认 `AStudio`） |
| `configPath` | 自定义 AStudio `config.toml` 路径 |

`cordis.patch.yml` 只注册插件，不改动 profile 当前的默认模型。

## 模型目录

模型清单与上下文参数来自 AStudio 的 **model-manager** 接口（`GET /api/v1/model-manager/models`，生产基址 `https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager`），这也是 AStudio 界面本身渲染的那份文档。认证使用 `astron-session.json` 里的 `modelBearerToken`（与聊天用的 `experimental_bearer_token` 是两套凭据）。

> 不使用 `/v1/models`：那是 OpenAI 兼容的发现端点，只返回一个更小、更旧的子集，会漏掉实际可调用的模型。

目录解析规则：

- 只收 `visibility` 为 `list` 的模型，`supported_in_api` 为 `false` 的不收；
- 上下文窗口与最大输出取自上游真实值（例如 `spark-x2.6-preview` 为 262144 / 100000）；
- 上游 `supported_reasoning_levels` 里的 `none` 被翻译成「可关闭思考」这个能力标记，不当作一个档位；
- 合并时内置清单的顺序与名称优先，上游独有的模型追加在末尾。

**降级顺序**：

1. 实时目录
2. 上次成功快照
3. 内置清单

快照写在 `$DSH_HOME/.astudio-connect/catalog.json`，按本地身份保存。目录来源（`live` / `saved` / `fallback`）与抓取时间都会显示在设置卡片上。

当前内置清单覆盖：

- **推理模型**：`spark-x2.5`、`spark-x2.6-preview`（可切换思考，支持 `low` / `high` / `max`）
- **对话模型**：`spark-x2.5-4b`、`xopglm52`、`xopdeepseekv4pro`、`xopdeepseekv4pro0813`、`xopdsv4flash0731in`、`astronclaw-auto`

## 推理档位与探测

WorkBuddy 类上游的推理档位信息分散在上游接口与客户端私有 UI 逻辑里，且模型目录变化很快。若插件凭经验为所有未声明模型补齐统一档位，就得持续追赶这些未公开、没有稳定契约的产品逻辑。

实测还发现，有些模型虽然接受 `reasoning_effort` 参数，却可能忽略未知值并回退到默认行为——一次请求返回成功，并不能证明某个档位真实可用。

因此本插件采用**用户主动授权触发、动态获取档位**的方式：

1. 设置卡片的「探测」分区对未声明档位的模型提供「探测 / 重新探测」；
2. 点击后插件发送带哨兵字符串的最小请求（`max_tokens: 1`，单请求超时 30 秒）；
3. 上游接受 → 记为 `validating`，只保存被接受的档位；上游以 `invalid_parameter_value` 拒绝 → 记为 `rejected` / `non-validating`；
4. 结果按 `account:modelId` 持久化，保留 24 小时后过期撤销。

探测会消耗少量积分。结果只表示当前上游接受该档位，**不承诺它一定改变推理效果、速度或积分消耗**。

`reasoning_effort` 到 pi-ai 档位的映射只开放上游声明过的档位；`off` 仅在模型声明了 `none`（即可关闭思考）时才开放。

## 模型显隐

在设置卡片的「上下文」分区可以勾选要在模型选择器中显示的模型。隐藏配置写在 `$DSH_HOME/.astudio-connect/model-visibility.json`，按本地身份保存。

- **只影响可选性**：隐藏的模型不出现在 picker、`listModels()` 和 shim 的 `/v1/models` 里；但正在使用该模型的已有会话不受影响，`resolveModel()` 不做过滤。
- **新账号和新上架模型默认显示**。

AStudio 的 token 不携带稳定 uid，因此本插件只有一个本地身份 `astudio-local`——目录快照、显隐偏好和探测记录都挂在它名下，不做多账号隔离。

## 积分余额徽标

选中 AStudio 模型时，输入框工具行（模型选择器旁）显示账户的两份积分余额，右侧带 ↻ 手动刷新：

```
通用 1393 · 星火 24621
```

两份积分分开显示、**不相加**，因为用途不同：

- **通用积分**（`totalBalance`）：所有模型，以及插件、Skill 调用等费用。
- **星火专属积分**（`sparkTotalBalance`）：仅星火模型的消耗。

数据来自 AStudio 桌面端自己使用的账户接口（`https://agent.xfyun.cn/xingchen-studio/points/balance`）。AStudio 的设置页会请求它自己的 loopback 服务，该服务带着桌面会话 Cookie 转发到账户 API；本插件直接用 `astron-session.json` 里已有的 `ssoSessionId` 访问同一个上游，因此**不新增位置发现，也不需要 AStudio 正在运行**。

> `ssoSessionId` 与模型目录用的 `modelBearerToken`、聊天用的 `experimental_bearer_token` 都在同一个文件里，但是三份不同用途的凭据。

行为约定：

- **读取时机**：徽标出现时读一次，以及点 ↻ 时再读一次。**不做定时轮询**——每次读取都会打一次上游。
- **可见性**：只在当前会话选中 AStudio 模型时出现，与 provider 无关的模型下不发起任何请求。
- **失败绝不显示假数字**：读不到就降级，不会把「读不懂」渲染成 `0`。
- **30 秒缓存**：成功的读取缓存 30 秒，↻ 会带 `?refresh=1` 绕过缓存；失败不缓存，下次读取重新问上游。

| 情况 | 表现 |
|---|---|
| 网络失败 / 上游异常 | 显示「暂不可用」，↻ 可重试 |
| 登录已失效（上游 `code: 80000`，或 401/403） | 显示「登录已失效」，需在 AStudio 重新登录 |
| 账户没有星火积分池 | 只显示通用积分，不显示 0 |
| 余额确实为 0 | 正常显示 `0`（0 是真实余额，不是未知） |
| 从未在 AStudio 登录 | 徽标整体不出现 |

> **已知限制**：账户接口只提供聚合余额，没有逐笔明细——AStudio 桌面端本身也是如此（它引导用户去网页查看明细）。因此徽标能反映「余额变化」，但无法给出「这一轮对话精确扣了多少」。

若徽标显示「暂不可用」且点击 ↻ 无效，先确认插件产物是否与运行中的 DSH 版本匹配：DSH 在启动时加载插件，重新构建后必须**完全退出并重启 DSH**（仅刷新页面不够）。

## 设置卡片

侧栏「插件」面板 → AStudio Connect，一张卡片分三个分区，随插件语言切换中英文：

- **账户**：登录态、配置文件路径、目录来源（实时 / 已保存 / 内置）、模型数，以及一键刷新目录。
- **上下文**：各模型的上下文窗口与最大输出，以及模型显隐开关。
- **探测**：未声明档位模型的探测状态与已接受档位，可手动探测 / 重新探测。

卡片挂载时读一次状态文档，之后每 60 秒重新读取一次；数据全部来自同源的 `GET /astudio/status`，不携带任何 token 材料。

### 同源路由一览

| 路径 | 方法 | 用途 | 防护 |
|---|---|---|---|
| `/astudio/status` | `GET` | 状态文档 | loopback Host + Origin |
| `/astudio/points` | `GET` | 积分余额（`?refresh=1` 绕过缓存） | loopback Host + Origin |
| `/astudio/update` | `GET` | 版本与更新信息 | loopback Host + Origin |
| `/astudio/probe/{modelId}` | `POST` | 推理档位探测 | loopback Host + Origin + 进程内探测密钥 |

探测路由单独要求进程内密钥（随状态文档下发、每进程轮换、不落盘）：状态路由的 loopback 校验挡住的是 DNS 重绑定的**页面**，那并不等于授权了一个**会改状态**的操作。

## 更新检查与主机心跳

**更新检查**（`update.ts`）：先读 npm 的公共 dist-tags 判断是否有更新——只看 `latest` 标签，预发布通道不是本插件的发布线；确认有更新后才查 GitHub releases 补充版本说明。两次请求都有超时（8 秒）与响应体大小上限，浏览器端还会用 `parseAStudioUpdateResult` 重新校验一遍版本号、发布 URL 和区间，任何一项不符就不渲染。

**主机心跳**（`host-heartbeat.ts`）：插件注册完 provider 后，在 `$DSH_HOME/.astudio-host-heartbeat.json` 写一份含 `pid` 与 `registeredAt` 的 JSON；宿主调用 `ctx.dispose()` 时删除。

心跳用来区分「宿主还在跑」和「宿主崩了但文件没清」。光看 PID 不够——崩溃后操作系统可能把同一个 PID 分给无关进程，那份没清掉的心跳就会误报「宿主存活」。所以判断条件是 PID 存在**且**持有该 PID 的进程启动时间不晚于 `registeredAt`；读不到启动时间时退化为只看 PID。

浏览器那一半不写文件，失败只通过 `console.error` 报告。这个不对称是有意的：宿主是承重的一半，缺心跳就明确意味着宿主没启动。

## 位置发现（Windows）

插件不假设 AStudio 装在固定路径，按以下顺序自动定位数据目录：

1. `configPath` 设置里显式指定的路径（直接采用，不探测）
2. 环境变量 `ASTUDIO_DATA_HOME`（直接采用，不探测）
3. AStudio 自己的注册表登记：`HKCU\Software\AStudioStorage` 的 `ProductionDataRoot` / `ProductionAcodeHome`
4. 安装目录同级的 `<安装目录名> Data`

第 3 项是 AStudio 官方自己写入的登记，因此换盘、换安装位置后无需任何配置。注册表记录存在但不完整或 schema 版本不受支持时会明确报错，不会静默降级成「未连接」——一份读不懂的旧安装不该压过一份新的安装。

注册表按发布通道区分值名前缀：`production` → `Production*`，`canary` → `Canary*`，`development` → `Development*`；第 4 项的目录名也随之为 `AStudio Data` / `AStudio Canary Data` / `AStudio Dev Data`。

非 Windows 平台不做自动发现，需要显式设置 `ASTUDIO_DATA_HOME`。

## DSH 版本支持

插件对宿主分两处声明依赖，都按 seam 包版本锁定在 **`0.2.0-rc.2`**。

**宿主侧 `peerDependencies`**（运行在宿主进程）：

| 包 | 用途 |
|---|---|
| `dsh-llm` / `dsh-llm-pi-ai` | 注册 `astudio` provider |
| `dsh-host-webserver` | 设置卡片与积分徽标的路由 |
| `dsh-settings` | 插件配置 |
| `dsh-home-paths` | 快照、显隐偏好与心跳的落盘位置 |
| `dsh-attachment` | 附件传递 |
| `@deepseek-ai/cordis` | `^4.0.2`（`4.x`） |
| `@deepseek-ai/schemastery` | `^3.18.2` |
| `react` | `^18.2.0` |

**浏览器侧 `dsh.client.inject`**（客户端 bundle 依赖的宿主包）：

`dsh-client-ui-renderer`、`dsh-client-ui-conversation`、`dsh-client-ui-model-selection`、`dsh-client-locale`、`dsh-api-remotes`、`dsh-api-session-controller`。

| 状态 | 版本 | 说明 |
|---|---|---|
| **支持** | DSH Desktop **2.0.17**（seam `0.2.0-rc.2`） | 当前开发与验证环境：provider 注册、设置卡片、积分徽标均在实机确认 |

## 已知限制

- [ ] **图片输入尚未启用**：adapter 已按目录声明把模型映射为 `input: ['text', 'image']`，但 model-manager 的解析目前固定 `supportsImages: false`（上游文档里也没有对应字段），因此当前所有模型都只接受纯文字。
- [ ] **更新检查依赖包已发布到 npm**：版本判断读的是 npm 公共 dist-tags，包未发布时这一步必然 404，更新检查恒为「不可用」。仓库地址此前指向不存在的组织，导致 GitHub releases 富化同样 404，现已修正（`src/version.ts` 与 `package.json` 的 `repository`）；发布包之后富化路径才真正生效。
- [ ] **自动位置发现只在 Windows 上实现**：macOS / Linux 需要显式设置 `ASTUDIO_DATA_HOME`。
- [ ] **只有一个本地身份**：AStudio token 不携带稳定 uid，目录快照、显隐偏好和探测记录都挂在 `astudio-local` 名下，不做多账号隔离。
- [ ] **不做逐笔扣费明细**：账户接口只给聚合余额，徽标只能反映余额变化。
- [ ] **不承诺长期兼容上游私有接口**：模型目录、账户接口与推理档位信息都是 AStudio 客户端自己的接口而非官方开放 API，上游改动可能使插件失效；届时插件按「上次成功目录 → 内置清单」降级并在卡片上标明来源，但不能保证长期兼容。
- [ ] **CLI 的 `status` 不反映实时目录**：见[命令行](#命令行)的说明。
- [ ] **不做账号切换跟随**：与 WorkBuddy 双 variant 不同，AStudio 只有一个产品，插件不复制 variant 级能力。

## 安全说明

- 凭证仅在内存中缓存，不写入任何文件；积分读取每次重新读会话文件（以便 AStudio 重新登录后立即生效），但只取 `ssoSessionId`。
- shim 只绑定 `127.0.0.1`，不接受外部网络访问。
- 入站请求需通过 Host、Origin、Content-Type、Bearer 共享密钥四重校验；Host 校验挡住 DNS 重绑定。
- 共享密钥是每进程随机生成的 32 字节值，用 `timingSafeEqual` 做常量时间比较；真正的 AStudio token 只由凭证层解析，从不经过请求头。
- token 不会在任何界面或日志中回显；CLI 的异常信息会剥离形如 JWT 的串。
- 积分路由与状态路由同样做 loopback Host / Origin 双重校验，回包只含数字和状态，账户凭据始终留在宿主进程内。
- 所有上游响应都视为不可信输入：流式读取带大小上限，路由回包在浏览器端重新校验后再渲染。

## 开发

```bash
npm install
npm run check      # typecheck + test + build
npm test           # 运行 263 个测试（28 个测试文件）
npm run build      # 产出 lib/（DSH 实际加载的目录）
```

`lib/` 里 `index.js` 是宿主入口，`client.js` 是浏览器 half，`bin.js` 是命令行。宿主与运行时依赖（pi-ai、cordis、schemastery、各 `dsh-*`）全部声明为 external，不打进 bundle，避免与 profile 里的宿主模块重复；浏览器侧只保留 React 为运行时依赖。

严格 TS，开启 `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`。

## 免责声明

本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 AStudio 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。

使用者需遵守 AStudio 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。

本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。

本项目与科大讯飞、AStudio、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 相关项目 / 社区生态

1. **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)**（MIT）— 同源的 DSH 桥接插件，面向 WorkBuddy 桌面应用。本项目的整体结构与它一致，上游换成 AStudio 的 maas-api。

适用版本与安装要求请参阅该项目说明。它由第三方独立维护；收录不代表官方背书，也不构成本插件内部接口的稳定性或兼容性承诺。

## 致谢

1. **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)**（MIT）— 本项目的整体结构、设置卡片分区、推理档位探测与 CLI 设计均参照它实现。

## 许可证

[MIT](./LICENSE)
