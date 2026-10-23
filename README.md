# dsh-astudio-connect

[English](./README.en.md) | 中文

将 AStudio 应用中已登录的模型接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)，零配置使用。

参考 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 的设计思路，针对 AStudio 的 maas-api（标准 OpenAI 协议）大幅精简。

> **零配置**：复用你本机 AStudio 的登录凭证，不重新登录，不落盘。

## 目录

- [安装](#安装)
- [功能](#功能)
- [配置](#配置)
- [模型目录](#模型目录)
- [推理档位与探测](#推理档位与探测)
- [模型显隐](#模型显隐)
- [积分余额徽标](#积分余额徽标)
- [计费与积分](#计费与积分)
- [设置卡片](#设置卡片)
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

**命令行**：

```bash
dsh plugin --profile web add dsh-astudio-connect@latest
```

把 `web` 换成你实际启动的 profile 名。

> 插件版本要与 DSH 内核代次对齐，否则宿主会直接拒载。装最新版即可；仍被拒载请把 DSH 内核版本和完整报错提到 [Issues](https://github.com/Cwentor/dsh-astudio-connect/issues)，不要绕过宿主校验。

### 验证

装完必须**完全退出并重启 DSH**，然后确认：

1. 模型选择器里出现 **AStudio** 分组；
2. 从分组里选一个模型，完成一次简短对话并能正常回复。

两条都满足才算安装成功。若分组不出现，到 profile 目录（`$DSH_HOME/profiles/<name>`）里跑 `npx dsh-astudio-connect doctor` 看登录态。

> 也可以把安装交给本机已有的 Agent（DSH Agent、Codex、Claude Code、Cursor 等），把下面这段话原样发给它：
>
> 请帮我安装并验证 DSH（DeepSeek Harness）插件 dsh-astudio-connect（npm 包名：`dsh-astudio-connect`）：
> 先阅读项目 README，确认我实际使用的界面（Web / Desktop / TUI）与 DSH 内核版本；
> Desktop 走「插件」面板的「添加插件」，填包名 `dsh-astudio-connect`；命令行 profile 用 `dsh plugin --profile <name> add dsh-astudio-connect@latest`，不要改依赖包或绕过宿主校验；
> 若宿主因版本代次不匹配拒载，把我的 DSH 内核版本和完整报错给我；
> 任何本地文件或配置改动，先征得我同意并做好备份；
> 装完后验证模型选择器里出现 AStudio 分组，并陪我完成一次简短对话。

## 功能

- **开箱即用**：安装并启用插件后即可在 DSH 中直接使用，无需额外配置。
- **凭证复用**：读取 AStudio 的 `experimental_bearer_token`，无需额外 OAuth 流程。
- **标准协议**：maas-api 是标准 OpenAI 兼容协议，pi-ai 原生支持，无需协议转换。
- **全能力桥接**：非流式、流式 SSE、工具调用、推理模型的 `reasoning_content`、上下文压缩，全部沿用 DSH 宿主自己的实现。
- **模型目录**：完全取自 AStudio 自己的 model-manager 接口，带真实的上下文窗口与最大输出；插件不内置任何清单，取不到就显示「无可用模型」。
- **推理档位探测**：对未声明档位的模型，由你主动授权后发送带哨兵的最小请求，确认上游真的校验 `reasoning_effort`，再逐项确认接受哪些档位。
- **模型显隐**：在设置卡片里勾选要在选择器中显示的模型；关掉的模型立刻从选择器消失，正用着它的会话需要另选模型才能继续发送。
- **余额速览**：选中 AStudio 模型时，输入框模型选择器旁显示账户的通用 / 星火两份积分余额，右侧 ↻ 手动刷新，不自动轮询。
- **设置卡片**：侧栏「插件」面板下的 AStudio Connect 卡片，分「账户 / 模型 / 探测」三个分区，可手动刷新目录、逐个探测。
- **命令行诊断**：`status` / `doctor` / `logout` 三个命令，全程不输出 token 材料。
- **更新检查**：对照 npm 公共 dist-tags 判断是否有新版本，并用 GitHub releases 补充说明。

## 配置

插件配置通过 DSH 的插件页管理（0.2.x 在侧栏「插件」面板 → AStudio Connect）：

| 字段 | 说明 |
|------|------|
| `displayName` | 模型选择器中显示的 provider 名称（默认 `AStudio`） |
| `configPath` | 自定义 AStudio `config.toml` 路径 |

`cordis.patch.yml` 只注册插件，不改动 profile 当前的默认模型。

## 模型目录

模型清单与上下文参数来自 AStudio 的 **model-manager** 接口。

**目录解析规则：**

- 只收 `visibility` 为 `list` 的模型，`supported_in_api` 为 `false` 的不收；上下文窗口或最大输出缺失的行也丢弃；
- 上下文窗口与最大输出取自上游真实值（例如 `spark-x2.6-preview` 为 262144 / 100000）。

**插件不内置任何模型清单**，列表完全以上游实际返回为准：

1. 实时目录 —— 上游本次返回的模型；
2. 上次成功快照 —— 上游这次没取到（网络、鉴权、响应异常）时的上一次结果，仍是上游数据；
3. 两者都没有 —— 列表为空。

第 3 种情况不用内置清单、占位或默认模型顶替：设置卡片显示「无可用模型」并说明原因（未登录 / 接口报错 / 响应无法解析 / 连不上 / 上游确实没列），模型选择器显示宿主的「暂无可用模型」。上游**明确返回空列表**同样按「无可用模型」处理并写入快照，否则之后一次失败的刷新会把已下架的模型顶回来。上游应答里若 `models` 字段缺失、类型不对，或所有行都不可用，则视为响应异常而不是「上游撤下了全部模型」，此时不覆盖已有快照。

## 推理档位与探测

WorkBuddy 类上游的推理档位信息分散在上游接口与客户端私有 UI 逻辑里，且模型目录变化很快。若插件凭经验为所有未声明模型补齐统一档位，就得持续追赶这些未公开、没有稳定契约的产品逻辑。

实测还发现，有些模型虽然接受 `reasoning_effort` 参数，却可能忽略未知值并回退到默认行为——一次请求返回成功，并不能证明某个档位真实可用。

因此本插件采用**用户主动授权触发、动态获取档位**的方式：

1. 设置卡片的「探测」分区对未声明档位的模型提供「探测 / 重新探测」；
2. 点击后插件发送带哨兵字符串的最小请求（`max_tokens: 1`，单请求超时 30 秒）；
3. 上游接受 → 记为 `validating`，只保存被接受的档位；上游以 `invalid_parameter_value` 拒绝 → 记为 `rejected` / `non-validating`；
4. 结果按 `account:modelId` 持久化，保留 24 小时后过期撤销。

探测会向上游发一次真实请求，消耗少量上游 token（与插件里其它调用一样，计入的是上游用量，不是 AStudio 积分——见[计费与积分](#计费与积分)）。结果只表示当前上游接受该档位，**不承诺它一定改变推理效果或速度**。

`reasoning_effort` 到 pi-ai 档位的映射只开放上游声明过的档位；`off` 仅在模型声明了 `none`（即可关闭思考）时才开放，并且**发出去的值是 `none` 而不是 `off`**——上游的词汇表只有 `none` / `high` / `max`，实测传 `off` 会被整包拒成 10005。

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

- **通用积分**（`totalBalance`）：所有模型，以及插件、Skill 调用等费用（这里是 AStudio 自身的插件与 Skill 调用，**不含本插件**）。
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

> **用插件对话时，这个数字不会变化。** 余额不变不等于没花钱，而是这笔调用压根没走 AStudio 那本账——机制见[计费与积分](#计费与积分)。

若徽标显示「暂不可用」且点击 ↻ 无效，先确认插件产物是否与运行中的 DSH 版本匹配：DSH 在启动时加载插件，重新构建后必须**完全退出并重启 DSH**（仅刷新页面不够）。

## 计费与积分

> **先说结论**：插件发起的调用**不消耗 AStudio 积分**。AStudio 的积分不由模型网关注销，而是桌面端按「轮次」自报用量后结算。插件是一个完全独立的进程，天生不在这条链路上。

真正扣钱的是桌面端，不是 `maas-api`：

1. acode 运行时开启一个 turn（带 `turn_id` / `thread_id` / `session_id`）；
2. 每次模型请求经桌面端的本地模型网关转发到 `model_providers.astron-spark.base_url`，网关把该请求的 input / output / cached token 作为 runtime event 记下来；
3. 轮次结束后，桌面端聚合成一份 `ClientTurnUsageReport`（schema 1.3），写入 `state.sqlite` 的 `turn_billing_outbox`；
4. `DirectPointsGateway.settle()` 带着桌面会话 Cookie `POST {studioApiBaseUrl}points/deduce-balance`，服务端据此算出 `ratedPoints`，扣 `GENERAL_POINTS` / `SPARK_POINTS`。

被计入积分需要同时满足三个条件：请求属于某个 acode turn、该 turn 以 `completed` 收尾、结算请求提交成功。缺任何一条都不扣费——**只是「请求从那个网关出去」并不够**。

### 这不等于「免费」

- **上游 token 照常消耗**，只是不进 AStudio 那本账；
- **余额闸门覆盖不到插件**：AStudio 在自己余额为 0 时会以 `402 astron_points_exhausted` 拦住请求，而这个判断发生在它自己的本地网关上；插件不经过那里，因此理论上余额为 0 时仍可发起调用（未实测，按当前实现推断）；
- **上游随时可以把计量下沉到网关**，改成按 uid / token 记账。那一天到来时这条通道会立即关闭，插件不需要改任何一行代码；
- **不要试图让插件「补上报」**：`ClientTurnUsageReport` 里的 `session_id` / `thread_id` / `call_ids` / `capability_usages` 只有 acode 运行时才产得出来，服务端另有 `turn_billing_usage_reviews` 做缺失审计。拼凑一份报告只会进审计表，不会让账变正确。

余额徽标读的就是 AStudio 自己的账本，用插件聊天时它当然不动——**余额不变不代表没花钱，只代表没走那本账**。使用前请先读[免责声明](#免责声明)。

## 设置卡片

侧栏「插件」面板 → AStudio Connect，一张卡片分三个分区，随插件语言切换中英文：

- **账户**：登录态、目录来源（实时 / 已保存 / 无可用模型）、模型数，以及一键刷新目录。
- **模型**：每个模型一个显隐开关，改完必须点「保存」才写入——关掉的模型立刻从 DSH 的模型选择器里消失。若某个会话正用着被关掉的模型，它需要另选一个模型才能继续发送。未保存时卡片标题栏显示「未保存 n」，正文显示「保存后向 DSH 暴露 n / m」，另有「撤销」丢弃本次改动。
- **探测**：每个模型的探测状态与已接受档位，可逐个探测 / 重新探测。按钮按下即变「探测中…」，同时给出按下位移与触感提示（平台支持时）。

卡片挂载时读一次状态文档，之后每 60 秒重新读取一次；数据全部来自同源的 `GET /astudio/status`，不携带任何 token 材料。

### 同源路由一览

| 路径 | 方法 | 用途 | 防护 |
|---|---|---|---|
| `/astudio/status` | `GET` | 状态文档 | loopback Host + Origin |
| `/astudio/points` | `GET` | 积分余额（`?refresh=1` 绕过缓存） | loopback Host + Origin |
| `/astudio/update` | `GET` | 版本与更新信息 | loopback Host + Origin |
| `/astudio/probe/{modelId}` | `POST` | 推理档位探测 | loopback Host + Origin + 进程内控制密钥 |
| `/astudio/visibility/{modelId}` | `POST` | 模型显隐（每改一个模型一条，由「保存」触发） | loopback Host + Origin + 进程内控制密钥 |

两条写路由（探测、显隐）要求同一个进程内控制密钥（随状态文档下发、每进程轮换、不落盘）：状态路由的 loopback 校验挡住的是 DNS 重绑定的**页面**，那并不等于授权了一个**会改状态**的操作。

## DSH 版本支持

| 插件版本 | 对应的 DSH 内核版本 |
|---|---|
| `0.1.1` | `0.2.1-rc.2` |
| `0.1.0` | `0.2.0-rc.2` |

内核代次不匹配时宿主会直接拒载。`0.1.0` 是对着 `0.2.0-rc.2` 发布的，那一代是实机验证环境；`0.1.1` 起对齐 `0.2.1-rc.2`，这一代次下 provider 注册、设置卡片、积分徽标由本地单元测试与集成测试覆盖，桌面端具体构建号仍需在新内核上重新确认。

## 请求被上游拒绝时

maas-api 对不合规的请求只回一句 `10005 invalid request`，不说明是哪个字段。插件按下面的顺序自愈，全部发生在转发层，DSH 与 pi-ai 不需要改动：

1. **线格式修复**：`tool_calls[].function.arguments` 不是字符串、`tool` 消息没有 `tool_call_id`、`content` 为 `null` —— 这些都是任何 OpenAI 兼容服务都不接受的形状，直接就地修好并记一条 warn。
2. **推理档位守卫**：请求里的 `reasoning_effort` 若不在该模型声明的档位内（或模型根本不支持推理），直接去掉该字段。网关是按模型校验这个值的，发了不存在的档位就是整包 400。
3. **形状回退**：去掉 `store` / `stream_options` / `prompt_cache_key` 等平台专有字段、`developer` 角色改写为 `system`；仍然 400 就把纯文本 content 数组压平成字符串。一旦某种形状被接受，本进程后续请求直接用它，不再多花往返。
4. **自诊断（每个进程最多一次）**：四种形状都被拒时，插件反过来问网关——依次只改一个维度（`max_tokens`、整份 `tools`、`reasoning_effort`、消息历史），再对出问题的那一项做二分查找。诊断结论会写进返回给 DSH 的错误信息（`diagnosis: ...`），能被诊断出的问题会**自动修好并重发**，修复在整个进程内保持：
   - `max_tokens` 超限 → 压到 8192；
   - 某个工具定义被拒 → 丢掉那一项（按名字记日志），其余工具照常生效；
   - 档位不被接受 → 去掉 `reasoning_effort`。

`store` 默认就不发（`supportsStore: false`），所以正常情况下第 1–3 步不会触发，也不产生额外请求。

被拒的请求体还会写一份到 `%TEMP%\dsh-astudio-connect\failed-requests\`（最多保留 5 份，单份上限 16 MB），因为只有真实请求体能看出网关到底不接受什么。该文件含对话正文，只在本机；设 `ASTUDIO_DUMP_FAILED=0` 可关闭，`ASTUDIO_DUMP_FAILED_DIR` 可改目录。

## 已知限制

- [ ] **图片输入尚未启用**：adapter 已按目录声明把模型映射为 `input: ['text', 'image']`，但 model-manager 的解析目前固定 `supportsImages: false`（上游文档里也没有对应字段），因此当前所有模型都只接受纯文字。
- [ ] **当前只支持 Windows**：macOS / Linux 未做适配与验证，不保证可用。
- [ ] **只有一个本地身份**：AStudio token 不携带稳定 uid，目录快照、显隐偏好和探测记录都挂在 `astudio-local` 名下，不做多账号隔离。
- [ ] **插件调用不计入 AStudio 积分**：积分由桌面端按 turn 自报结算，插件不产生 turn，因此不扣费；这实际上是一条不被计量的通道，见[计费与积分](#计费与积分)。这里不提供任何补齐上报的能力。
- [ ] **余额闸门不覆盖插件**：AStudio 自己在余额为 0 时返回 `402`，该判断在它的本地网关内；插件绕过该网关，所以余额耗尽也不会被它拦住（推断，未实测）。
- [ ] **不做逐笔扣费明细**：账户接口只给聚合余额，徽标只能反映余额变化；插件调用则完全不产生扣费记录，更谈不上明细。
- [ ] **不承诺长期兼容上游私有接口**：模型目录、账户接口与推理档位信息都是 AStudio 客户端自己的接口而非官方开放 API，上游改动可能使插件失效；届时插件按「上次成功目录」降级，连快照都没有时如实显示无可用模型，但不能保证长期兼容。
- [ ] **CLI 的 `status` 会发起一次实时刷新**：它现在等待一次真实请求，才能如实报出目录来源与模型数；离线或未登录时报告 `empty` 与对应的失败原因。
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
npm test           # 运行 302 个测试（29 个测试文件）
npm run build      # 产出 lib/（DSH 实际加载的目录）
```

`lib/` 里 `index.js` 是宿主入口，`client.js` 是浏览器 half，`bin.js` 是命令行。宿主与运行时依赖（pi-ai、cordis、schemastery、各 `dsh-*`）全部声明为 external，不打进 bundle，避免与 profile 里的宿主模块重复；浏览器侧只保留 React 为运行时依赖。

严格 TS，开启 `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`。

## 免责声明

本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 AStudio 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。

使用者需遵守 AStudio 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。

**本插件不实现 AStudio 的用量上报与积分结算**：通过它发起的调用不会进入 AStudio 的积分账本（机制见[计费与积分](#计费与积分)）。这个落差源于对方「客户端自报」的计费模型，不是本项目的功能卖点，也不应被用来规避计费。若你希望为这些调用付费，请使用 AStudio 官方客户端。

本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。

本项目与科大讯飞、AStudio、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 相关项目 / 社区生态

- **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)**（MIT）— 同源的 DSH 桥接插件，面向 WorkBuddy 桌面应用。本项目的整体结构与它一致，上游换成 AStudio 的 maas-api。

> 适用版本与安装要求请参阅该项目说明。它由第三方独立维护；收录不代表官方背书，也不构成本插件内部接口的稳定性或兼容性承诺。

## 致谢

- **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)**（MIT）— 本项目的整体结构、设置卡片分区、推理档位探测与 CLI 设计均参照它实现。

## 许可证

[MIT](./LICENSE)
