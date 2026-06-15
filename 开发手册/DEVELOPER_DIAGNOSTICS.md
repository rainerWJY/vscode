# 开发者诊断指南

> 本文档来自在 VS Code Agent Host + Sessions Web 客户端中实现自定义 OpenAI 兼容 Agent（`openai-agent`）的经验总结。

## 第一原则

**只修改 `src/vs/platform/openAIAgent/` 目录下的代码。如需修改其他目录的文件，必须先征得用户同意。**

## 金法则

**修 Bug 之前：先加日志，确认猜想，再动手。**

永远不要跳过日志直接改代码。没有日志你只能猜测，有了日志你就能精确看到数据流在哪里断裂。

---

## 热重载工作流

| 组件 | 修改的代码 | 编译 | 重启 |
|------|-----------|------|------|
| Agent host（服务端） | `src/vs/platform/openAIAgent/node/` | `npm run transpile-client` | 杀掉 + 重启 agent host |
| Web 客户端（浏览器） | `src/vs/workbench/**/*.ts`, `src/vs/sessions/**/*.ts` | `npm run watch-client-transpile` | 刷新浏览器 (Cmd+R) |
| 两者 | — | `npm run transpile-client` | 两者都做 |

最快循环：
```bash
# 终端 1 — 监听编译（保存后自动编译）
npm run watch-client-transpile

# 终端 2 — agent host
VSCODE_SKIP_PRELAUNCH=1 node scripts/code-agent-host.js --port 8082 --without-connection-token --log info

# 终端 3 — web 服务器
node scripts/code-sessions-web.js --port 8081 --connect ws://localhost:8082 --skip-welcome
```

修改服务端代码：杀掉 agent host → `npm run transpile-client` → 重启。
修改客户端代码：只需刷新浏览器标签页。

---

## 关键 Bug 模式与修复

### 1. 文本显示为叠加/错乱

**症状**：文本显示为 `"Hi!Hi! HowHi! How can..."`（重复累积）。

**根因**：AHP 协议的 `SessionResponsePart` action 按 `partId` **替换** 内容。如果发送 `_emitMarkdownDelta(event.content)`（SSE 增量），每个 chunk 会覆盖前一个，UI 只能看到最后一个 chunk。

**修复**：始终发送**累积的**内容：
```typescript
// ✅ 正确：累积内容
let content = '';
for await (const event of events) {
    if (event.type === 'delta') {
        content += event.content;
        this._emitMarkdownDelta(content);  // ← 累积的
    }
}
// ❌ 错误：只发增量——UI 是替换不是追加
this._emitMarkdownDelta(event.content);
```

### 2. "You need to set up GitHub Copilot" — SetupAgent 拦截消息

**症状**：Agent host session 的消息永远到不了后端。第一轮正常，但后续消息显示 "Chat is almost ready" 或 Copilot 登录错误。

**根因**：`SetupAgent` 被注册为默认 chat agent。当 `agentIdSilent` 未设置时（例如调用了 `unlockFromCodingAgent()`），chat service 会把所有消息路由到 `SetupAgent`，它会阻塞等待 Copilot 授权。

**修复**：OpenAI agent 在客户端的 session type 是 `agent-host-openai-agent`（由 `agentHostChatContribution.ts` 动态生成）。它注册了 `ChatSessionContribution`，所以 `getChatSessionContribution()` 能找到它 → `lockToCodingAgent()` 设置 `_lockedAgent` → `agentIdSilent` 正确传递。**不要**在 `unlockFromCodingAgent()` 中添加 `sessionType.includes('openai-agent')` 的 special case——这会破坏消息路由链。

**验证**：消息通过 `AgentHostSessionHandler` 处理，它通过 AHP WebSocket 连接 `connection.dispatch()` 发送 `SessionTurnStartedAction`。

### 3. subscribe 时报 "Session not found on backend"

**症状**：客户端用 URI `A` 创建 session，服务端用 URI `B` 创建 session，客户端无法订阅。

**修复**：在 `IAgent.createSession()` 中，尊重客户端 eager-create 流程传入的 `config?.session` 参数：
```typescript
const sessionUri = config?.session ?? AgentSession.uri(AGENT_ID, generateUuid());
```

### 4. SessionTurnStarted 重复发射导致响应部分错乱

**症状**：响应部分落到错误的 turn 中。

**根因**：客户端（protocol handler）和 agent 的 `send()` 方法都发射了 `SessionTurnStarted`。只有 protocol handler 应该发射它。

**修复**：从 `send()` 中删除 `_emitAction(SessionTurnStarted)`。turn 的生命周期由客户端管理。

---

## 架构速查

### 消息流向（后续轮次）

```
用户在 chat widget 中输入
  → chatWidget._acceptInput()
  → chatService.sendRequest(sessionResource, msg, { agentIdSilent: lockedAgentId })
  → ChatService 根据 agentIdSilent 查找 agent → AgentHostSessionHandler._invokeAgent()
  → _handleTurn() → dispatch(SessionTurnStartedAction) 通过 AHP WebSocket
  → Agent host 处理 → 流式返回 SessionResponsePart / SessionToolCallXxx
  → protocol handler 应用到 chat model → UI 重新渲染
```

### Agent host 注册（服务端）

```
agentHostServerMain.ts:
  server.registerAgent(new OpenAIAgent(logService, fileService))
  server.registerAgent(new CopilotAgent(...))
```

### Session type 解析（客户端）

```
agentHostChatContribution.ts:
  sessionType = `agent-host-${agent.provider}`  // 例如 "agent-host-openai-agent"
  registerChatSessionContribution({ type: sessionType, ... })
  → AgentHostSessionHandler 用 agentId = sessionType 注册
```

### URL scheme

| Scheme | 含义 |
|--------|------|
| `openai-agent:/<uuid>` | 后端 session URI（服务端） |
| `agent-host-openai-agent://<uuid>` | 客户端聊天资源 URI |
| `agent-host-copilotcli://<uuid>` | Copilot CLI 聊天资源 URI |
| `local-chat-session:/<uuid>` | 本地（离线）聊天 session |

---

## 日志导航

```bash
# Agent host 日志
tail -f ~/Library/Application\ Support/code-oss-dev/logs/$(ls -t ~/Library/Application\ Support/code-oss-dev/logs/ | head -1)/agenthost-server.log

# 搜索 openai-agent 相关日志
grep '\[OpenAIAgent\]\|\[OpenAIAgentSession\]\|\[OpenAIApiClient\]' <logfile>
```

## 常用文件路径

| 用途 | 路径 |
|------|------|
| OpenAI agent 服务端实现 | `src/vs/platform/openAIAgent/node/openAIAgent.ts` |
| OpenAI session + tool 循环 | `src/vs/platform/openAIAgent/node/openAIAgentSession.ts` |
| OpenAI API 客户端 (SSE) | `src/vs/platform/openAIAgent/node/openAIApiClient.ts` |
| Tool 定义 | `src/vs/platform/openAIAgent/node/openAIAgentTools.ts` |
| System prompt | `src/vs/platform/openAIAgent/node/openAIAgentPrompts.ts` |
| Agent host 注册入口 | `src/vs/platform/agentHost/node/agentHostServerMain.ts` |
| Agent host session 处理器 | `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts` |
| Chat contribution 注册 | `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostChatContribution.ts` |
| Sessions web 入口 | `scripts/code-sessions-web.js` |
| Sessions widget 锁定状态 | `src/vs/sessions/contrib/chat/browser/chatView.ts` |
| Setup agent（Copilot 关卡） | `src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupProviders.ts` |
