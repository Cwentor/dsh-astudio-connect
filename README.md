# dsh-astudio-connect

将 AStudio 应用中已登录的模型复用到 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 中使用的桥接插件。参考 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 的设计思路，针对 maas-api 的标准 OpenAI 协议大幅精简。

> **零配置**：复用你本机 AStudio 的登录凭证，不重新登录，不落盘。

## 特性

- 复用 AStudio 应用的 `experimental_bearer_token`，无需额外 OAuth 流程。
- maas-api 是标准 OpenAI 兼容协议，pi-ai 原生支持，无需协议转换。
- 支持非流式、流式 SSE、工具调用，以及推理模型的 `reasoning_content`。
- 本地 loopback shim 提供四重入站校验（Host / Origin / JSON / 共享密钥）。
- 凭证内存缓存，不落盘，不回显。

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

## 安全说明

- 凭证仅在内存中缓存，不写入任何文件。
- shim 只绑定 `127.0.0.1`，不接受外部网络访问。
- 入站请求需通过 Host、Origin、Content-Type、Bearer 共享密钥四重校验。
- token 不会在任何界面或日志中回显。

## 开发

```bash
npm install
npm run check      # typecheck + test + build
npm test           # 运行 56 个测试
npm run build      # 产出 dist/
```

## 许可证

[MIT](./LICENSE)
