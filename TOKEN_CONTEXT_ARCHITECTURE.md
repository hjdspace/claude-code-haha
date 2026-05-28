# Token统计与上下文用量统计 - 完整架构分析

## 1. 架构概览

这是一个**前后端分离**的桌面应用架构：

```
┌──────────────────────────────────────────────────────────────────────┐
│                        桌面前端 (desktop/)                           │
│                    React + TypeScript + Zustand                       │
│                                                                      │
│  ┌─────────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │ ContextUsage     │    │  chatStore       │    │  WebSocket    │  │
│  │ Indicator.tsx    │◄───│  (状态管理)      │◄───│  Manager      │  │
│  └─────────────────┘    └──────────────────┘    └───────────────┘  │
│         │                      │                        │            │
│         ▼                      ▼                        ▼            │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              sessions.ts (HTTP API客户端)                    │    │
│  │              getInspection() → 获取上下文数据                 │    │
│  └─────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP / WebSocket
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     Claude Code 后端 (src/)                            │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │               核心统计逻辑 (被前端复用)                         │   │
│  │                                                               │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐       │   │
│  │  │ tokenEstima │  │   tokens.ts │  │ analyzeContext  │       │   │
│  │  │    tion.ts  │  │             │  │      .ts        │       │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘       │   │
│  │                                                               │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐       │   │
│  │  │ context.ts  │  │cost-tracker │  │  bootstrap/     │       │   │
│  │  │             │  │    .ts      │  │   state.ts      │       │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              server/api/sessions.ts                           │   │
│  │              提供HTTP端点给前端调用                            │   │
│  └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

## 2. 关键发现：前端复用了后端代码

**桌面前端并不自己计算token统计**，而是通过HTTP API调用后端，后端复用核心统计逻辑。

### 2.1 后端统计代码被复用的方式

**后端核心文件**（被桌面前端通过API调用）：

| 后端文件 | 功能 | 被前端使用方式 |
|---------|------|--------------|
| [tokens.ts](file:///workspace/src/utils/tokens.ts) | Token提取和计算 | HTTP API内部使用 |
| [tokenEstimation.ts](file:///workspace/src/services/tokenEstimation.ts) | Token计数 | HTTP API内部使用 |
| [context.ts](file:///workspace/src/utils/context.ts) | 上下文窗口管理 | HTTP API内部使用 |
| [analyzeContext.ts](file:///workspace/src/utils/analyzeContext.ts) | 上下文详细分解 | HTTP API内部使用 |
| [cost-tracker.ts](file:///workspace/src/cost-tracker.ts) | 成本追踪 | HTTP API内部使用 |

### 2.2 前端如何获取数据

**前端文件**（消费后端API）：

| 前端文件 | 功能 |
|---------|------|
| [sessions.ts](file:///workspace/desktop/src/api/sessions.ts) | HTTP API客户端 |
| [websocket.ts](file:///workspace/desktop/src/api/websocket.ts) | WebSocket通信 |
| [chatStore.ts](file:///workspace/desktop/src/stores/chatStore.ts) | Zustand状态管理 |
| [ContextUsageIndicator.tsx](file:///workspace/desktop/src/components/chat/ContextUsageIndicator.tsx) | 上下文用量UI组件 |

## 3. 详细数据流

### 3.1 前端获取上下文数据

```
用户打开会话
    ↓
ContextUsageIndicator.tsx 组件挂载
    ↓
调用 sessionsApi.getInspection(sessionId, { includeContext: true })
    ↓
┌─────────────────────────────────────────────────────────────┐
│ HTTP POST /api/sessions/:id/inspection                      │
│                                                             │
│ 后端处理 (server/api/sessions.ts:554-571):                  │
│ 1. 获取会话消息                                             │
│ 2. 调用 analyzeContextUsage() 计算上下文分解                │
│ 3. 返回 SessionContextSnapshot                              │
└─────────────────────────────────────────────────────────────┘
    ↓
前端接收 SessionContextSnapshot
    ↓
更新本地状态并渲染UI
```

### 3.2 后端API实现

查看 [sessions.ts:554-571](file:///workspace/src/server/api/sessions.ts#L554-L571)：

```typescript
// 后端API端点
response.context = await conversationService.requestControl(
  sessionId,
  { subtype: 'get_context_usage', estimateOnly: true },
  20_000,
)
```

**关键点**：后端在处理请求时：
1. 获取当前会话的所有消息
2. 调用 `analyzeContextUsage()` 函数（来自 [analyzeContext.ts](file:///workspace/src/utils/analyzeContext.ts)）
3. 返回完整的 `SessionContextSnapshot` 对象

### 3.3 后端统计逻辑流程

```
analyzeContextUsage() 被调用
    ↓
并行计算各类别token:
  ┌─────────────────────────────────────────┐
  │ Promise.all([                            │
  │   countSystemTokens(),      // 系统提示词  │
  │   countMemoryFileTokens(),  // CLAUDE.md  │
  │   countBuiltInToolTokens(), // 内置工具   │
  │   countMcpToolTokens(),     // MCP工具    │
  │   countCustomAgentTokens(), // 自定义agent│
  │   countSlashCommandTokens(),// 斜杠命令   │
  │   approximateMessageTokens(),// 对话消息   │
  │ ])                                       │
  └─────────────────────────────────────────┘
    ↓
生成 ContextData 对象
    ↓
序列化并返回给前端
```

## 4. 桌面前端架构详解

### 4.1 状态管理 (Zustand)

[chatStore.ts](file:///workspace/desktop/src/stores/chatStore.ts) 使用Zustand管理会话状态：

```typescript
type PerSessionState = {
  messages: UIMessage[]
  chatState: ChatState
  connectionState: ConnectionState
  tokenUsage: TokenUsage  // ← 存储token使用
  // ...
}
```

### 4.2 WebSocket实时通信

[websocket.ts](file:///workspace/desktop/src/api/websocket.ts)：

```typescript
class WebSocketManager {
  // 管理WebSocket连接
  connect(sessionId: string) {
    const ws = new WebSocket(buildSessionWebSocketUrl(sessionId))
    // 处理实时消息：message_complete, status, content_delta...
  }
  
  // 发送消息到后端
  send(sessionId: string, message: ClientMessage) {
    ws.send(JSON.stringify(message))
  }
  
  // 监听后端消息
  onMessage(sessionId: string, handler: MessageHandler) {
    conn.handlers.add(handler)
  }
}
```

### 4.3 上下文用量UI组件

[ContextUsageIndicator.tsx](file:///workspace/desktop/src/components/chat/ContextUsageIndicator.tsx)：

```typescript
export function ContextUsageIndicator({ sessionId, chatState, ... }) {
  // 调用API获取上下文数据
  const refresh = useCallback(async () => {
    const inspection = await sessionsApi.getInspection(activeSessionId, {
      includeContext: true,
      contextOnly: true,
      timeout: 20_000,
    })
    
    // 设置上下文状态
    const nextContext = inspection.context ?? inspection.contextEstimate ?? null
    setContext(nextContext)
    setContextSource(nextSource)
  }, [sessionId])
  
  // 渲染圆环进度条 + 详情弹窗
  return (
    <button>
      <span className="ring" style={{ background: `conic-gradient(...)` }} />
      <span>{percentage}%</span>
    </button>
  )
}
```

## 5. 数据结构对应关系

### 5.1 前端定义的类型

```typescript
// desktop/src/api/sessions.ts:139-191
export type SessionContextSnapshot = {
  categories: Array<{
    name: string
    tokens: number
    color: string
    isDeferred?: boolean
  }>
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  gridRows: Array<Array<{...}>>
  model: string
  memoryFiles: Array<{ path: string; type: string; tokens: number }>
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  // ... 更多字段
}
```

### 5.2 后端返回的类型

后端 [analyzeContext.ts](file:///workspace/src/utils/analyzeContext.ts) 返回的 `ContextData` 与前端的 `SessionContextSnapshot` 结构高度一致。

## 6. 完整请求流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          用户交互层                                      │
│  用户打开会话 → ContextUsageIndicator 挂载                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          前端组件层                                      │
│  ContextUsageIndicator.tsx                                             │
│    │                                                                  │
│    ├── useEffect → 触发 refresh()                                      │
│    │                                                                  │
│    └── sessionsApi.getInspection(sessionId, {includeContext: true})    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP POST
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          后端API层                                      │
│  server/api/sessions.ts:getInspection()                                │
│    │                                                                  │
│    ├── 获取会话状态                                                    │
│    │                                                                  │
│    └── conversationService.requestControl(                            │
│          sessionId,                                                    │
│          { subtype: 'get_context_usage', estimateOnly: true }           │
│        )                                                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          核心计算层                                      │
│  query.ts → 消息预处理                                                  │
│    │                                                                  │
│    └── analyzeContextUsage()                                          │
│          │                                                            │
│          ├── countSystemTokens()         → 系统提示词                  │
│          ├── countMemoryFileTokens()     → CLAUDE.md文件              │
│          ├── countBuiltInToolTokens()    → 内置工具                    │
│          ├── countMcpToolTokens()        → MCP工具                    │
│          ├── countCustomAgentTokens()    → 自定义agent                 │
│          ├── countSlashCommandTokens()    → 斜杠命令                    │
│          └── approximateMessageTokens()   → 对话消息                    │
│                │                                                        │
│                └── tokenCountWithEstimation()                          │
│                      │                                                  │
│                      ├── getTokenUsage()      ← 从API响应提取            │
│                      └── roughTokenCountEstimation() ← 估算新增消息      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ 返回 ContextData
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          后端API层                                      │
│  序列化 ContextData → SessionContextSnapshot                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP Response
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          前端组件层                                      │
│  ContextUsageIndicator.tsx                                             │
│    │                                                                  │
│    ├── setContext(context)                                            │
│    │                                                                  │
│    └── 渲染UI:                                                        │
│          • 圆环进度条 (百分比)                                          │
│          • 详情弹窗 (各类别token分解)                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

## 7. 实时更新机制

### 7.1 WebSocket消息处理

前端通过WebSocket监听后端事件，实时更新token统计：

```typescript
// chatStore.ts:1216-1588
handleServerMessage(sessionId, msg) {
  switch (msg.type) {
    case 'status':
      // 更新token使用
      if (msg.tokens) {
        update((session) => ({
          tokenUsage: { ...session.tokenUsage, output_tokens: msg.tokens }
        }))
      }
      break
      
    case 'message_complete':
      // 消息完成，更新完整usage
      update(() => ({
        tokenUsage: msg.usage  // ← 完整的BetaUsage对象
      }))
      break
  }
}
```

### 7.2 自动刷新

```typescript
// ContextUsageIndicator.tsx:175-181
useEffect(() => {
  if (chatState === 'idle') return
  const timer = setInterval(() => {
    void refresh('auto')
  }, ACTIVE_REFRESH_MS)  // 30秒刷新一次
  return () => clearInterval(timer)
}, [chatState, messageCount, refresh])
```

## 8. 架构优势

1. **代码复用**：后端核心统计逻辑被前端完全复用
2. **前后端分离**：前端只负责UI渲染，后端负责复杂计算
3. **实时性**：WebSocket提供实时状态更新
4. **一致性**：前端显示的数据与后端计算完全一致
5. **可扩展性**：新增统计维度只需修改后端 `analyzeContext.ts`

## 9. 相关文件索引

### 前端 (desktop/)

| 文件 | 用途 |
|------|------|
| [App.tsx](file:///workspace/desktop/src/App.tsx) | 根组件 |
| [ContextUsageIndicator.tsx](file:///workspace/desktop/src/components/chat/ContextUsageIndicator.tsx) | 上下文用量指示器 |
| [sessions.ts](file:///workspace/desktop/src/api/sessions.ts) | HTTP API客户端 |
| [websocket.ts](file:///workspace/desktop/src/api/websocket.ts) | WebSocket管理器 |
| [chatStore.ts](file:///workspace/desktop/src/stores/chatStore.ts) | Zustand状态存储 |

### 后端 (src/)

| 文件 | 用途 |
|------|------|
| [tokens.ts](file:///workspace/src/utils/tokens.ts) | Token提取与计算 |
| [tokenEstimation.ts](file:///workspace/src/services/tokenEstimation.ts) | Token计数服务 |
| [context.ts](file:///workspace/src/utils/context.ts) | 上下文窗口管理 |
| [analyzeContext.ts](file:///workspace/src/utils/analyzeContext.ts) | 上下文分析核心 |
| [cost-tracker.ts](file:///workspace/src/cost-tracker.ts) | 成本追踪 |
| [bootstrap/state.ts](file:///workspace/src/bootstrap/state.ts) | 全局状态 |
| [server/api/sessions.ts](file:///workspace/src/server/api/sessions.ts) | 后端API端点 |

## 10. 总结

**桌面前端通过HTTP API调用后端，复用了后端的token统计和上下文分析代码**。这种架构设计确保了：

- ✅ 数据一致性：前端显示的数据与后端计算逻辑完全一致
- ✅ 代码复用：核心统计逻辑只需维护一份
- ✅ 性能优化：复杂计算在后端进行，减少前端负担
- ✅ 实时更新：通过WebSocket实现状态同步
