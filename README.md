# dsh-astudio-connect

将 AStudio 应用中已登录的模型复用到 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 中使用的桥接插件。参考 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 的设计思路，针对 maas-api 的标准 OpenAI 协议大幅精简。

> **零配置**：复用你本机 AStudio 的登录凭证，不重新登录，不落盘。

## 特性

- 复用 AStudio 应用的 `experimental_bearer_token`，无需额外 OAuth 流程。
- maas-api 是标准 OpenAI 兼容协议，pi-ai 原生支持，无需协议转换。
- 支持非流式、流式 SSE、工具调用，以及推理模型的 `reasoning_content`。
- 本地 loopback shim 提供四重入站校验（Host / Origin / JSON / 共享密钥）。
- 凭证内存缓存，不落盘，不回显。
- 输入框旁显示账户积分余额（通用 / 星火分列），仅在选中 AStudio 模型时出现。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- AStudio 应用已安装并登录（提供 maas-api token）
- DeepSeek Harness（DSH）运行时

## 安装

将本仓库安装为 DSH 插件。DSH 通过 `cordis.patch.yml` 注册插件清单，启动时自动加载。

```bash
# 从本地目录安装
npm install -D ./dsh-astudio-connect
```

或在 DSH 插件管理器中添加本目录路径。

## 工作原理

插件通过三层桥接把 maas-api 的模型注册进 DSH 的 `llm` seam：

1. **凭证层**（`auth.ts`）：读取 AStudio `config.toml` 中的 `experimental_bearer_token`，内存缓存，不落盘。
2. **本地 shim**（`shim.ts`）：在 `127.0.0.1` 上启动 OpenAI 兼容端点，经过四重入站校验后，将请求转发到 maas-api。
3. **pi-ai 适配**（`adapter.ts`）：用 `openAICompletionsApi()` + `PiAiAdapter` 将 shim 的端点注册为 DSH 的 `astudio` provider。

```
DSH (llm seam) → AStudioPiAiAdapter → 127.0.0.1 shim → maas-api (Bearer token)
```

模型目录与积分余额走另外两条只读路径，都不经过 shim：

```
model-manager API ← modelBearerToken（模型清单与上下文参数）
账户积分 API     ← ssoSessionId（通用 / 星火积分余额）
```

这三份凭据都来自 AStudio 自己的文件，但用途不同、互不通用。

## 配置

插件配置通过 DSH 设置页（`/settings` → Plugins → AStudio）管理：

| 字段 | 说明 |
|------|------|
| `displayName` | 模型选择器中显示的 provider 名称（默认 `AStudio`） |
| `configPath` | 自定义 AStudio `config.toml` 路径 |

## 位置发现（Windows）

插件不再假设 AStudio 装在固定路径，按以下顺序自动定位数据目录：

1. `configPath` 设置里显式指定的路径（直接采用，不探测）
2. 环境变量 `ASTUDIO_DATA_HOME`
3. AStudio 自己的注册表登记：`HKCU\Software\AStudioStorage` 的 `ProductionDataRoot` / `ProductionAcodeHome`
4. 安装目录同级的 `<安装目录名> Data`

第 3 项是 AStudio 官方自己写入的登记，因此换盘、换安装位置后无需任何配置。注册表记录存在但不完整或版本不受支持时会明确报错，不会静默降级成"未连接"。

## 模型目录

模型清单与上下文参数来自 AStudio 的 **model-manager** 接口（`GET /api/v1/model-manager/models`），这也是 AStudio 界面本身渲染的那份文档。认证使用 `astron-session.json` 里的 `modelBearerToken`（与聊天用的 `experimental_bearer_token` 是两套凭据）。

> 不使用 `/v1/models`：那是 OpenAI 兼容的发现端点，只返回一个更小、更旧的子集，会漏掉实际可调用的模型。

上下文窗口与最大输出取自上游真实值（例如 `spark-x2.6-preview` 为 262144 / 100000）。当前覆盖：

- 推理模型：spark-x2.5、spark-x2.6-preview（可切换思考，支持 high / max）
- 对话模型：spark-x2.5-4b、xopglm52、xopdeepseekv4pro、xopdeepseekv4pro0813、xopdsv4flash0731in、astronclaw-auto

降级顺序：实时目录 → 上次成功快照 → 内置清单。

## 积分余额徽标

选中 AStudio 模型时，输入框工具行（模型选择器旁）显示账户的两份积分余额，右侧带 ↻ 手动刷新：

```
通用 1393 · 星火 24621
```

两份积分分开显示、**不相加**，因为用途不同：

- **通用积分**（`totalBalance`）：所有模型，以及插件、Skill 调用等费用。
- **星火专属积分**（`sparkTotalBalance`）：仅星火模型的消耗。

数据来自 AStudio 桌面端自己使用的账户接口。AStudio 的设置页会请求它自己的 loopback 服务，该服务带着桌面会话 Cookie 转发到账户 API；本插件直接用 `astron-session.json` 里已有的 `ssoSessionId` 访问同一个上游，因此**不新增位置发现，也不需要 AStudio 正在运行**。

> `ssoSessionId` 与模型目录用的 `modelBearerToken`、聊天用的 `experimental_bearer_token` 都在同一个文件里，但是三份不同用途的凭据。

行为约定：

- **读取时机**：徽标出现时读一次，以及点 ↻ 时再读一次。**不做定时轮询**——每次读取都会打一次上游。
- **可见性**：只在当前会话选中 AStudio 模型时出现，与 provider 无关的模型下不发起任何请求。
- **失败绝不显示假数字**：读不到就降级，不会把「读不懂」渲染成 `0`。

| 情况 | 表现 |
|---|---|
| 网络失败 / 上游异常 | 显示「暂不可用」，↻ 可重试 |
| 登录已失效（`code: 80000` 或 401/403） | 显示「登录已失效」，需在 AStudio 重新登录 |
| 账户没有星火积分池 | 只显示通用积分，不显示 0 |
| 余额确实为 0 | 正常显示 `0`（0 是真实余额，不是未知） |
| 从未在 AStudio 登录 | 徽标整体不出现 |

> **已知限制**：账户接口只提供聚合余额，没有逐笔明细——AStudio 桌面端本身也是如此（它引导用户去网页查看明细）。因此徽标能反映「余额变化」，但无法给出「这一轮对话精确扣了多少」。

若徽标显示「暂不可用」且点击 ↻ 无效，先确认插件产物是否与运行中的 DSH 版本匹配：DSH 在启动时加载插件，重新构建后必须**完全退出并重启 DSH**（仅刷新页面不够）。

## 安全说明

- 凭证仅在内存中缓存，不写入任何文件；积分读取每次重新读会话文件（以便 AStudio 重新登录后立即生效），但只取 `ssoSessionId`。
- shim 只绑定 `127.0.0.1`，不接受外部网络访问。
- 入站请求需通过 Host、Origin、Content-Type、Bearer 共享密钥四重校验。
- token 不会在任何界面或日志中回显。
- 积分路由与状态路由同样做 loopback Host / Origin 双重校验，回包只含数字和状态，账户凭据始终留在宿主进程内。

## 开发

```bash
npm install
npm run check      # typecheck + test + build
npm test           # 运行 261 个测试
npm run build      # 产出 lib/（DSH 实际加载的目录）
```

## 许可证

[MIT](./LICENSE)
