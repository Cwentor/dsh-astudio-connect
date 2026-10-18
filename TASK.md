# 微任务清单

dsh-astudio-connect 插件的微任务拆解。每个任务独立交付，配套测试，可增量提交。

## 执行原则

- 每个微任务独立 commit，标题格式：`Txxx: <描述>`
- 严格按验收标准实现，超出范围的功能不实现
- 所有新增逻辑必须配套编写测试
- 代码风格遵循项目现有规范（strict TypeScript, noUncheckedIndexedAccess）

---

## Phase 0: 项目骨架

### T001: 项目脚手架

**交付物**
- `package.json`（依赖、脚本、DSH 清单声明）
- `tsconfig.json`（严格模式，排除 src/client）
- `tsconfig.client.json`（客户端代码，jsx: react-jsx）
- `.gitignore`
- `cordis.patch.yml`（DSH 插件注册声明）

**验收标准**
1. `npm install` 成功安装所有依赖
2. `npx tsc -p tsconfig.json --noEmit` 通过（无类型错误）
3. `npx tsc -p tsconfig.client.json --noEmit` 通过
4. `cordis.patch.yml` 格式正确（YAML 解析成功）

---

## Phase 1: 核心桥接

### T010: 凭证读取 `auth.ts`

**交付物**
- `src/auth.ts` — 从 AStudio config.toml 读取 experimental_bearer_token
- `tests/auth.spec.ts` — 测试覆盖

**验收标准**
1. 从 `D:\IDE\AStudio Data\runtime\acode-home\config.toml` 读取 token
2. 正则匹配 `experimental_bearer_token\s*=\s*"([^"]+)"`
3. 内存缓存，不写任何文件
4. 文件不存在时返回 undefined（不抛异常）
5. 测试覆盖：成功读取、缓存命中、文件缺失、格式异常

### T011: 上游客户端 `upstream.ts`

**交付物**
- `src/upstream.ts` — maas-api 标准 fetch 客户端
- `tests/upstream.spec.ts` — 测试覆盖

**验收标准**
1. `POST https://maas-api.cn-huabei-1.xf-yun.com/v1/chat/completions`
2. `Authorization: Bearer <token>` header
3. 支持非流式和流式（SSE）
4. 错误分类：401（auth）、404（not_found）、429（rate）、5xx（server）、400（client）
5. 测试覆盖：200 非流式、200 流式、401、404、500

### T012: 本地 shim `shim.ts`

**交付物**
- `src/shim.ts` — loopback 端点 + 四重入站校验 + 转发
- `tests/shim.spec.ts` — 测试覆盖

**验收标准**
1. 绑定 `127.0.0.1` 随机端口
2. 四重入站校验：Host（loopback）、Origin（loopback）、JSON Content-Type、共享密钥 Bearer
3. 路由：`GET /healthz`、`GET /v1/models`、`POST /v1/chat/completions`
4. 转发到 upstream，透传请求体
5. 流中断时返回 `data: [DONE]\n\n`
6. 测试覆盖：healthz、models、chat（非流式+流式）、host 拒绝、origin 拒绝、密钥拒绝、JSON 拒绝、404

### T013: 模型目录 `catalog.ts`

**交付物**
- `src/catalog.ts` — 模型目录管理 + maas-api 刷新
- `tests/catalog.spec.ts` — 测试覆盖

**验收标准**
1. 从 maas-api `GET /v1/models` 加载模型列表
2. 内存缓存，可手动刷新
3. 模型信息：id、name、推理能力、contextWindow、maxTokens
4. 文件缺失时使用内置默认目录
5. 测试覆盖：加载、刷新、缓存、默认目录

---

## Phase 2: Adapter

### T020: pi-ai 适配器 `adapter.ts`

**交付物**
- `src/adapter.ts` — createProvider + PiAiAdapter
- `tests/adapter.spec.ts` — 测试覆盖

**验收标准**
1. `createProvider` 注册到 DSH llm seam
2. 模型描述：api=`openai-completions`, baseUrl=shim/v1, compat.maxTokensField=`max_tokens`
3. 推理模型的 thinkingLevelMap 映射
4. `resolveApiKey` 返回 shim 共享密钥
5. 测试覆盖：provider 创建、模型列表、模型解析、推理映射

---

## Phase 3: 入口 + UI

### T030: 插件入口 `index.ts`

**交付物**
- `src/index.ts` — 插件入口、生命周期、UI slot 注入
- `tests/index.spec.ts` — 测试覆盖

**验收标准**
1. 插件注册到 DSH（cordis.patch.yml）
2. 启动时创建 shim + adapter + catalog
3. 停止时关闭 shim
4. 注入 UI slot（settings.plugin.item）
5. 测试覆盖：初始化、启动、停止、slot 注册

### T031: 设置页 UI `client/index.tsx`

**交付物**
- `src/client/index.tsx` — 设置页组件
- `tests/client.spec.ts` — 测试覆盖

**验收标准**
1. 显示连接状态（已连接/未连接）
2. 显示 token 信息（长度+前缀，不回显完整值）
3. 显示模型列表
4. 测试覆盖：渲染、状态显示、token 脱敏

---

## Phase 4: 集成

### T040: 集成测试

**交付物**
- `tests/integration.spec.ts` — 端到端集成测试
- 全量测试通过

**验收标准**
1. auth → upstream → shim → adapter 全链路可用
2. 非流式请求成功
3. 流式请求成功
4. 工具调用成功
5. 推理模型返回 reasoning_content
6. `npm run check`（typecheck + test + build）全部通过

---

## 任务状态

| 任务 | 状态 | Commit |
|------|------|--------|
| T001 | done | T001: scaffold |
| T010 | done | T010: auth |
| T011 | done | T011: upstream |
| T012 | done | T012: shim |
| T013 | done | T013: catalog |
| T020 | done | T020: adapter |
| T030 | pending | — |
| T031 | pending | — |
| T040 | pending | — |
