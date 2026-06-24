# OpenAI Agent — 功能对比与待办列表

> Copilot Agent vs OpenAI Agent 功能差异追踪

## 图例

| 符号 | 含义 |
|------|------|
| ✅ | 已实现 |
| 🔄 | 部分实现/可改进 |
| ❌ | 缺失 |
| 🏗️ | 架构差异 |

---

## 一、工作台聊天模式 (ChatModeKind)

| # | 特性 | Copilot | OpenAI | 状态 | 备注 |
|---|------|---------|--------|------|------|
| 1 | **Ask 模式** (纯问答) | `default` participant, `modes: [Ask]` | — | ❌ | 需要注册一个只读的 `IAgent` |
| 2 | **Agent 模式** (全工具调用) | `editsAgent` participant, `modes: [Agent]` | 默认工作模式 | ✅ | — |
| 3 | **Edit 模式** (编辑选中代码) | `editingSession` participant, `modes: [Edit]` | — | ❌ | 需要注册一个编辑专用的 `IAgent` |

## 二、Agent Host 会话配置

| # | 特性 | Copilot | OpenAI | 状态 | 备注 |
|---|------|---------|--------|------|------|
| 4 | **`mode` 属性** (interactive/plan) | `platformSessionSchema` 定义，UI dropdown | `OPENAI_AGENT_CONFIG_SCHEMA` 添加 | ✅ | — |
| 5 | **`autoApprove` 属性** | `platformSessionSchema` 定义 | `OPENAI_AGENT_CONFIG_SCHEMA` 添加 | ✅ | — |
| 6 | **config → mode 运行时读取** | `_resolveSdkMode()` → `session.applyMode()` | `sendMessage()` 读取 → `OpenAIAgentSessionOptions` | ✅ | — |

## 三、Plan 模式行为

| # | 特性 | Copilot | OpenAI | 状态 | 备注 |
|---|------|---------|--------|------|------|
| 7 | **Plan mode 系统提示词** | 同一个静态提示词，SDK 内部注入 | `SYSTEM_PROMPT_PLAN` 独立提示词 | ✅ | — |
| 8 | **Plan mode 工具过滤** | SDK 端处理，主机侧不过滤 | `_getAvailableTools()` 过滤 destructive | ✅ | — |
| 9 | **`exit_plan_mode` 工具** | SDK 内置，自动注册/注销 | — | ❌ | **高优先级** — 模型无法自主退出 plan mode |
| 10 | **计划评审 UI** | `handleExitPlanModeRequest()` → 模态框 | — | ❌ | 需要 plan review 交互界面 |

## 四、Autopilot / 自动批准

| # | 特性 | Copilot | OpenAI | 状态 | 备注 |
|---|------|---------|--------|------|------|
| 11 | **autopilot mode 映射** | `interactive + autopilot` → SDK `autopilot` | `autoApprove === 'autopilot'` → `autoApprove: true` | ✅ | — |
| 12 | **工具自动批准** | `autoApprove: true` 消除确认提示 | 同左 | ✅ | — |
| 13 | **plan mode 退出自动批** | `autopilot` 时跳过 UI | — | ❌ | 依赖 `exit_plan_mode` |

## 五、会话历史 & 持久化

| # | 特性 | Copilot | OpenAI | 状态 | 备注 |
|---|------|---------|--------|------|------|
| 14 | **历史会话恢复完整对话** | SDK 管理，`getSessionMessages()` 返回 `Turn[]` | `sendMessage()` 加载 `_loadSessionData()` | ✅ | 2025-06-22 修复 |
| 15 | **`_reconstructTurns()` 收集所有 assistant 块** | SDK 管理 | 遍历到 next user，收集所有块 | ✅ | 2025-06-22 修复 |
| 16 | **Fork Conversation** | `createSession({ fork })` 完整支持 | 复制 source 消息到新会话磁盘文件 | ✅ | 2025-06-22 修复 |

## 六、Config Schema 可改进项

| # | 特性 | Copilot | OpenAI | 状态 | 备注 |
|---|------|---------|--------|------|------|
| 17 | **Schema 复用 `platformSessionSchema`** | 展开标准 schema | 独立 schema | 🔄 | 低优先级，不影响功能 |
| 18 | **`sessionMutable` 动态修改** | `SessionConfigPropertySchema` 支持 | `ConfigPropertySchema` 不支持 | 🔄 | 低优先级，重启会话后重新计算 |

## 七、架构差异 (Architecture)

| # | 特性 | Copilot | OpenAI | 状态 | 备注 |
|---|------|---------|--------|------|------|
| 19 | **LLM API 客户端** | Copilot CLI SDK (RPC) | OpenAI-compatible REST API | 🏗️ | 架构选择，无法复用 |
| 20 | **多 participant 注册** | 4+ participants (default, editsAgent, vscode, editingSession) | 单个 `IAgent` | 🏗️ | 如果需要模式切换 UI 则需要改 |
| 21 | **子代理继承父 mode** | SDK 自动处理 | 子代理固定 `mode: 'interactive'` | ❌ | `_runSubagent()` 中需传递父 session mode |

---

## 待办优先级

### P0 — 核心协作能力

- [ ] **`exit_plan_mode` 工具** — 允许模型在 plan mode 中自主请求退出并切换回 interactive
- [ ] **子代理继承父 mode** — `_runSubagent()` 中读取父 session mode 并传递给子代理

### P1 — 提升用户体验

- [ ] **Plan Review UI** — 当模型请求 exit_plan_mode 时，显示计划评审界面
- [ ] **注册 Ask participant** — 创建一个只读的 `IAgent`（ID: `openai-ask`）注册到 `agentService`，使工作台 mode picker 显示 Ask 选项

### P2 — 锦上添花

- [ ] **复用 `platformSessionSchema.definition`** — 减少 schema 重复
- [ ] **跳过 system prompt 重新生成** — 当 mode 切换时更新已有 session 的 system prompt，而非仅影响新 session
