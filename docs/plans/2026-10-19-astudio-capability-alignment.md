# AStudio Connect 完整能力对齐实施计划

> 本计划交 `dev-executing-plans` 逐任务执行；任务用 `Txxx` 编号，提交使用通用 conventional commit。

**Goal:** 将 `dsh-astudio-connect` 从“maas-api 精简桥接”补齐为与 `dsh-workbuddy-connect` 对齐的能力面：凭证诊断、目录持久化与来源、模型能力元数据、图片输入、推理探测、模型显隐、设置卡片、CLI 和运营路由。

**Architecture:** 保留现有三层桥接 `auth → upstream → loopback shim → pi-ai adapter`，新增 `catalog/probe/visibility/identity/diagnostics/cli/update/heartbeat` 模块。AStudio 只有一个产品，因此不复制 WorkBuddy 的双 variant，只把 variant 级能力抽象成本地 identity；单个本地身份足以承载目录、显隐和探测持久化。

**Tech Stack:** TypeScript ESM、Node HTTP、React、Vitest、tsdown、DSH seam。

**Spec:** `dsh-workbuddy-connect` 的 README、`src/auth.ts`、`src/catalog.ts`、`src/adapter.ts`、`src/bin.ts`、`src/client/WorkBuddyPluginCard.tsx`；`dsh-astudio-connect` 现有 README、TASK、src 与 tests。

## Global Constraints

- Node `^22.19.0 || >=24.0.0`；严格 TS，`noUncheckedIndexedAccess`，`exactOptionalPropertyTypes`。
- 每个 Txxx 先写失败测试，再实现；不实现验收标准之外的功能。
- 不回显 token，不写桌面应用文件，不绕过上游校验。
- 单个微任务独立提交，提交信息使用 `feat(scope): description`、`test(scope): description`、`docs(scope): description`。
- 本地身份为 `astudio-local`，因为 AStudio token 不携带稳定 uid；该裁决记录在进度台账。

## Review Focus

- 无 token 时目录应为空还是 fallback？采用：auth 未连接时仍注册 provider，但 settings 显示未连接，`/v1/models` 只返回已解析模型。
- `/v1/models` 过滤 hidden 后，正在使用隐藏模型的已有会话不受影响。
- 推理探测只发送带哨兵的少量请求，结果按 account/model 持久化，过期时间可撤销。
- CLI 的 status/doctor/logout 不得输出 token 材料。
- 目录 fetch 失败时保留上次成功目录，不回退为不可用列表。

### T001 设计文档与执行台账

**Files:**
- Create: `docs/plans/2026-10-19-astudio-capability-alignment.md`
- Create: `docs/progress.md`
- Modify: `.gitignore` 增加 `docs/progress.md`

**Acceptance:**
- [ ] 计划文档存在，含 Goal/Architecture/Global Constraints/Review Focus 和 T001-T015 任务清单。
- [ ] `docs/progress.md` 第一行包含 `# ledger — plan: docs/plans/2026-10-19-astudio-capability-alignment.md`。
- [ ] `.gitignore` 包含 `docs/progress.md`。
- [ ] `git status` 只包含本任务文件。

### T002 凭证诊断 API

**Files:**
- Modify: `src/auth.ts`
- Test: `tests/auth.spec.ts`

**Interfaces:**
- `AStudioCredentialStore` 新增 `status(): Promise<AStudioAuthStatus>` 和 `logout(): Promise<void>`。
- `AStudioAuthStatus = { state: 'signed-in' | 'signed-out'; configPath: string; tokenLength?: number; hints: string[] }`。

**Acceptance:**
- [ ] `status()` 未登录时返回 `signed-out`，并给出“sign in / missing config” hint。
- [ ] `status()` 已登录时只返回 `tokenLength`，不返回 token。
- [ ] `logout()` 清除内存缓存，不删除 AStudio 配置文件。
- [ ] `tests/auth.spec.ts` 覆盖三种状态，全部通过。

### T003 本地身份与目录持久化

**Files:**
- Create: `src/identity.ts`
- Create: `src/catalog-store.ts`
- Modify: `src/catalog.ts`
- Test: `tests/catalog.spec.ts`

**Interfaces:**
- `localIdentity()` 返回 `'astudio-local'`。
- `WorkBuddyCatalogStore` 风格：`AStudioCatalogStore` 支持 `get(identity)`、`put(identity, models, fetchedAtMs)`、`delete(identity)`，文件位于 `resolveDshHome()/.astudio-connect/catalog.json`。

**Acceptance:**
- [ ] 目录 refresh 成功后保存当前 identity 的模型快照。
- [ ] refresh 失败时优先返回上次成功目录，source 标为 `saved`。
- [ ] 从未成功 fetch 时返回 fallback，source 标为 `fallback`。
- [ ] 目录来源可通过 `catalogSource()` 读取。

### T004 模型显隐持久化

**Files:**
- Create: `src/visibility-store.ts`
- Modify: `src/catalog.ts`、`src/shim.ts`、`src/adapter.ts`
- Test: `tests/model-visibility.spec.ts`

**Interfaces:**
- `AStudioVisibilityStore` 支持 `hidden(identity, modelId)`、`setVisible(identity, modelId, visible)`，文件位于 `resolveDshHome()/.astudio-connect/model-visibility.json`。
- Adapter 在 `listModels()` 中按当前 identity 过滤，不过滤 `resolveModel()`。

**Acceptance:**
- [ ] 隐藏的模型不出现在 `/v1/models` 和 picker 中。
- [ ] 已使用隐藏模型的会话仍可 `resolveModel()`。
- [ ] 切换 identity 时读各自显隐列表；本地身份只有一个 `astudio-local`。
- [ ] 测试覆盖保存、读取、隐藏过滤和既有会话不受影响。

### T005 adapter 模型能力元数据

**Files:**
- Modify: `src/catalog.ts`、`src/adapter.ts`
- Test: `tests/adapter.spec.ts`

**Acceptance:**
- [ ] `AStudioModelInfo` 新增 `supportsImages?: boolean`、`reasoning?: { supports?: boolean; supportedEfforts?: string[]; canDisableThinking?: boolean }`。
- [ ] 模型声明支持图片时 `input` 为 `['text','image']`，否则 `['text']`。
- [ ] reasoning 档位只映射 `supportedEfforts` 中声明的档位，`off` 仅在 `canDisableThinking` 为 true 时开放。
- [ ] 默认 catalog 中 spark-x2.5/spark-x2.6-preview 保留 `low/high/max`；其他模型无图片声明。

### T006 推理探测存储

**Files:**
- Create: `src/probe-store.ts`
- Test: `tests/probe-store.spec.ts`

**Acceptance:**
- [ ] 按 `account:modelId` 保存探测记录，含 `validation`、`efforts`、`expiresAtMs`。
- [ ] `get(account, modelId)` 只返回未过期且匹配 account 的记录。
- [ ] `clear()` 删除本地身份所有记录。
- [ ] 文件位于 `resolveDshHome()/.astudio-connect/probe.json`，格式损坏时安全降级。

### T007 推理探测服务

**Files:**
- Create: `src/probe.ts`
- Create: `src/probe-service.ts`
- Test: `tests/probe.spec.ts`

**Acceptance:**
- [ ] 探测使用 `modelWithPrompt` 构造带哨兵字符的最小请求，超时 30s。
- [ ] 上游返回 `invalid_parameter_value` 等拒绝码时归类为 rejected。
- [ ] 上游接受档位时归类为 validating，并只保存 `acceptedEfforts`。
- [ ] 未授权时不发送任何请求。

### T008 探测路由

**Files:**
- Create: `src/probe-route.ts`
- Test: `tests/probe-route.spec.ts`

**Acceptance:**
- [ ] `POST /astudio/probe/{modelId}` 要求本地回环 Host 和共享密钥。
- [ ] 返回 JSON：`state`、`validation`、`efforts`、`reason`。
- [ ] 探测成功后使 adapter 目录快照失效。
- [ ] 不返回 token 或上游原文。

### T009 status route 扩展

**Files:**
- Modify: `src/web-status.ts`
- Test: `tests/web-status.spec.ts`

**Acceptance:**
- [ ] 返回 `auth`（state、tokenLength）、`catalog`（source、modelCount、models）、`visibility`（hidden modelIds）、`probe`（当前身份探测摘要）。
- [ ] Host 非回环返回 403。
- [ ] 不返回完整 token。

### T010 设置卡片

**Files:**
- Modify: `src/client/index.tsx`
- Test: `tests/client.spec.ts`

**Acceptance:**
- [ ] 卡片显示 status/context/detail 三个标签。
- [ ] status 显示登录态、目录来源、令牌有效期占位。
- [ ] context 显示模型上下文和图片能力。
- [ ] detail 显示模型列表、费率占位和探测摘要。
- [ ] 提供手动刷新目录、探测、显隐开关。

### T011 CLI

**Files:**
- Create: `src/bin.ts`
- Modify: `package.json` 增加 `bin`
- Test: `tests/bin.spec.ts`

**Acceptance:**
- [ ] `status --json` 输出登录态、目录来源、模型数，无 token。
- [ ] `doctor` 输出配置路径、文件存在性、hints。
- [ ] `logout` 清除内存缓存并返回；不删除 AStudio 配置文件。
- [ ] `--provider` 只接受 `astudio`。

### T012 update route

**Files:**
- Create: `src/version.ts`、`src/update-route.ts`
- Test: `tests/update-route.spec.ts`

**Acceptance:**
- [ ] `GET /astudio/update` 返回包名、当前版本、仓库信息。
- [ ] 不返回 token 或内部文件路径。

### T013 host heartbeat

**Files:**
- Create: `src/host-heartbeat.ts`
- Test: `tests/host-heartbeat.spec.ts`

**Acceptance:**
- [ ] 插件启动时写 heartbeat 文件，包含 pid、registeredAt。
- [ ] 插件停止时清除文件。
- [ ] `isHeartbeatProcessAlive` 对死 pid 返回 false。

### T014 loopback usable port

**Files:**
- Create: `src/loopback.ts`
- Modify: `src/shim.ts`
- Test: `tests/loopback.spec.ts`

**Acceptance:**
- [ ] `bindToUsablePort` 在 fetch 保留端口时重新绑定。
- [ ] shim ready 使用 `bindToUsablePort`。

### T015 全量验证

**Files:**
- 无新增生产代码，只补集成测试。
- Test: `tests/integration.spec.ts`

**Acceptance:**
- [ ] `npm run typecheck` 通过。
- [ ] `npm test` 全部通过。
- [ ] `npm run build` 通过。
- [ ] 本分支 `git diff master...HEAD` 只包含本计划范围。

---

## 补充对齐（T016–T020）

T001–T015 覆盖计划声明的能力面。相对 `dsh-workbuddy-connect` 的全部模块逐文件比对后，仍有三类缺口：真实能力缺口、接线缺口、共享类型重构。以下补足，不推翻任何既有裁决（双 variant、WSL、桌面凭据保护、legacy 设置、WorkBuddy gateway UA 仍不移植）。

### T016 update 真实版本检查 + 接线

**Files:**
- Create: `src/update.ts`
- Modify: `src/update-route.ts`、`src/index.ts`
- Test: `tests/update.spec.ts`（新增），扩展 `tests/update-route.spec.ts`

**Acceptance:**
- [ ] `checkAStudioUpdate` 先读 npm dist-tags 判断是否有新版本，再富化 GitHub releases，失败时降级。
- [ ] 版本比较遵循 SemVer 优先级，prerelease 规则与上游一致。
- [ ] `registerAStudioUpdateRoute` 在 index.ts 中以 `ASTRO_VERSION` 注册，路由实际返回 checkAStudioUpdate 的结果。
- [ ] 不回显 token；上游响应有大小上限和超时。

### T017 探测路由接线

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.spec.ts`（扩展）

**Acceptance:**
- [ ] index.ts 创建 probe store、probe service、probe key，并调用 `registerAStudioProbeRoute`。
- [ ] probe route 注册后 `POST /astudio/probe/{modelId}` 可达（需要 loopback + 共享 key）。

### T018 status 路由探测摘要接线

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.spec.ts`（扩展）

**Acceptance:**
- [ ] `registerAStudioStatusRoute` 收到 probe store，status 文档的 `probe` 段填充真实记录。

### T019 pi-ai-guard 诊断

**Files:**
- Create: `src/pi-ai-guard.ts`
- Modify: `src/index.ts`（或 adapter.ts）
- Test: `tests/pi-ai-guard.spec.ts`

**Acceptance:**
- [ ] `resolvedPiAiVersion()` 读取实际加载的 `@earendil-works/pi-ai` 版本。
- [ ] 版本不匹配时 `piAiVersionWarning()` 返回诊断文案，匹配或不可读时返回 undefined。
- [ ] 在插件加载时记录警告（非致命）。

### T020 status-paths 共享类型/路径

**Files:**
- Create: `src/status-paths.ts`
- Modify: `src/web-status.ts`、`src/probe-route.ts`、`src/update-route.ts`
- Test: 各路由测试回归

**Acceptance:**
- [ ] 路由路径常量集中到 `src/status-paths.ts`。
- [ ] web-facing 类型（status/probe/update 响应形状）集中或引用，不重复定义。




