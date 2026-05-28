# Token统计与上下文用量统计架构文档

## 1. 概述

本文档详细描述了桌面应用程序中token统计和上下文用量统计的完整实现架构。从用户输入消息到上下文用量百分比的显示，整个数据流涉及多个层次的处理和计算。

## 2. 核心架构层次

系统采用分层架构，各层职责明确：

```
┌─────────────────────────────────────────────────────────┐
│                    UI展示层                              │
│  StatusLine / ContextVisualization / Stats.tsx           │
├─────────────────────────────────────────────────────────┤
│                  上下文分析层                             │
│  analyzeContext.ts - 按类别分解上下文使用情况              │
├─────────────────────────────────────────────────────────┤
│                  Token提取层                             │
│  tokens.ts - 从API响应中提取usage数据                    │
├─────────────────────────────────────────────────────────┤
│                  Token计数层                             │
│  tokenEstimation.ts - 实际token计数和估算                 │
├─────────────────────────────────────────────────────────┤
│                  API响应层                               │
│  消息中的usage字段包含input_tokens, output_tokens等       │
└─────────────────────────────────────────────────────────┘
```

## 3. 详细数据流分析

### 3.1 用户输入到API响应

当用户输入消息时，系统执行以下流程：

1. **消息处理** (`src/types/message.ts`)
   - 用户输入被封装为 `UserMessage` 类型
   - 消息通过查询循环发送到API

2. **API调用** (`src/query.ts`)
   - 消息经过微压缩（microcompact）处理
   - 发送到Anthropic API
   - API返回响应包含 `usage` 字段

3. **Usage数据结构**
   ```typescript
   interface BetaUsage {
     input_tokens: number;
     output_tokens: number;
     cache_creation_input_tokens?: number;
     cache_read_input_tokens?: number;
   }
   ```

### 3.2 Token计数层详解

**文件**: [tokenEstimation.ts](file:///workspace/src/services/tokenEstimation.ts)

#### 3.2.1 精确计数方法

```typescript
// 使用Anthropic API的countTokens端点
async function countTokensWithAPI(content: string): Promise<number | null>

// 批量消息计数
async function countMessagesTokensWithAPI(
  messages: BetaMessageParam[],
  tools: BetaToolUnion[]
): Promise<number | null>
```

#### 3.2.2 粗略估算方法

```typescript
// 基于字符的粗略估算 (字符数 / 4)
function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4
): number

// 批量消息估算
function roughTokenCountEstimationForMessages(
  messages: readonly Message[]
): number
```

#### 3.2.3 Fallback机制

```typescript
// Haiku模型fallback
async function countTokensViaHaikuFallback(
  messages: BetaMessageParam[],
  tools: BetaToolUnion[]
): Promise<number | null>
```

计数优先级：
1. 优先使用API的countTokens端点
2. 失败时使用Haiku模型计数
3. 最后fallback到粗略估算

### 3.3 Token提取层详解

**文件**: [tokens.ts](file:///workspace/src/utils/tokens.ts)

#### 3.3.1 从消息中提取Usage

```typescript
// 核心函数：从消息中获取API返回的usage数据
function getTokenUsage(message: Message): Usage | undefined {
  if (message?.type === 'assistant' && 'usage' in message.message) {
    return message.message.usage;
  }
  return undefined;
}
```

#### 3.3.2 计算上下文窗口Token总数

```typescript
// 计算总token数：input + cache + output
function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  );
}
```

#### 3.3.3 获取当前上下文Token数（核心函数）

```typescript
// 这是测量上下文大小的标准函数，用于阈值检查
export function tokenCountWithEstimation(
  messages: readonly Message[]
): number {
  // 1. 从最后一条有usage的assistant消息获取API计数
  // 2. 估算自该消息后新增的token
  // 3. 返回总估算值
  
  // 特殊处理并行工具调用场景：
  // - 多个content block可能来自同一API响应
  // - 遍历回溯找到第一个相同id的消息
  // - 确保所有interleaved工具结果都被计入
}
```

### 3.4 上下文窗口管理详解

**文件**: [context.ts](file:///workspace/src/utils/context.ts)

#### 3.4.1 获取模型上下文窗口大小

```typescript
function getContextWindowForModel(model: string): number {
  // 优先级：
  // 1. 环境变量 CLAUDE_CODE_MAX_CONTEXT_TOKENS (ANT only)
  // 2. 模型名称中的 [1m] 后缀
  // 3. 配置的context window
  // 4. OpenAI Codex context window
  // 5. 模型能力中的max_input_tokens
  // 6. Beta 1M上下文头
  // 7. 实验性1M启用
  // 8. 默认值 200,000
}
```

#### 3.4.2 计算上下文百分比

```typescript
// 计算used和remaining百分比
function calculateContextPercentages(
  currentUsage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null,
  contextWindowSize: number
): { used: number | null; remaining: number | null }
```

#### 3.4.3 计算当前上下文Token总数

```typescript
// 考虑API响应中的output tokens（它们会成为下一轮的输入）
function calculateCurrentContextTokenTotal(
  estimatedTokens: number,
  currentUsage: {...} | null,
  contextWindow?: number
): number
```

### 3.5 上下文分析层详解

**文件**: [analyzeContext.ts](file:///workspace/src/utils/analyzeContext.ts)

这是最核心的分析模块，将上下文使用情况按类别分解：

#### 3.5.1 ContextData输出结构

```typescript
interface ContextData {
  categories: ContextCategory[];     // 各分类的token使用
  totalTokens: number;               // 总token数
  maxTokens: number;                 // 上下文窗口大小
  percentage: number;                 // 使用百分比
  gridRows: GridSquare[][];          // 可视化网格数据
  model: string;
  memoryFiles: MemoryFile[];         // CLAUDE.md文件
  mcpTools: McpTool[];               // MCP工具
  agents: Agent[];                   // 自定义agents
  skills?: SkillInfo;                // 技能统计
  apiUsage: {...} | null;           // 实际API使用数据
}
```

#### 3.5.2 上下文分类

系统将上下文分解为以下类别：

| 类别 | 说明 | Token计算 |
|------|------|-----------|
| System prompt | 系统提示词 | 调用API计数 |
| System tools | 内置工具定义 | 工具schema token化 |
| MCP tools | MCP服务器工具 | 工具schema token化 |
| Custom agents | 自定义agent | agent配置token化 |
| Memory files | CLAUDE.md文件 | 文件内容token化 |
| Skills | 技能frontmatter | 技能描述token化 |
| Messages | 对话消息 | 微压缩后token化 |
| Autocompact buffer | 自动压缩预留空间 | 固定阈值 |
| Free space | 剩余空间 | 自动计算 |

#### 3.5.3 核心分析流程

```typescript
async function analyzeContextUsage(
  messages: Message[],
  model: string,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  tools: Tools,
  agentDefinitions: AgentDefinitionsResult,
  terminalWidth?: number,
  toolUseContext?: ToolUseContext,
  mainThreadAgentDefinition?: AgentDefinition,
  originalMessages?: Message[],
  analysisOptions?: { estimateOnly?: boolean }
): Promise<ContextData>
```

**并行分析步骤**：

```typescript
// 使用Promise.all并行执行各类别的token计数
const [
  { systemPromptTokens, systemPromptSections },
  { claudeMdTokens, memoryFileDetails },
  { builtInToolTokens, deferredBuiltinDetails, ... },
  { mcpToolTokens, mcpToolDetails, deferredToolTokens },
  { agentTokens, agentDetails },
  { slashCommandTokens, commandInfo },
  messageBreakdown,
] = await Promise.all([
  countSystemTokens(effectiveSystemPrompt, estimateOnly),
  countMemoryFileTokens(estimateOnly),
  countBuiltInToolTokens(tools, ...),
  countMcpToolTokens(tools, ...),
  countCustomAgentTokens(agentDefinitions, estimateOnly),
  countSlashCommandTokens(tools, ...),
  approximateMessageTokens(messages, estimateOnly),
]);
```

## 4. 成本追踪层

**文件**: [cost-tracker.ts](file:///workspace/src/cost-tracker.ts)

### 4.1 会话成本追踪

```typescript
// 核心数据结构
interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

// 累加到会话总成本
export function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string
): number
```

### 4.2 按模型追踪

```typescript
// 从usage提取并累加
function addToTotalModelUsage(
  cost: number,
  usage: Usage,
  model: string
): ModelUsage {
  const modelUsage = getUsageForModel(model);
  modelUsage.inputTokens += usage.input_tokens;
  modelUsage.outputTokens += usage.output_tokens;
  modelUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  modelUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
  // ...
}
```

## 5. 状态管理层

**文件**: [bootstrap/state.ts](file:///workspace/src/bootstrap/state.ts)

全局状态存储关键数据：

```typescript
type State = {
  totalCostUSD: number;
  totalAPIDuration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  modelUsage: { [modelName: string]: ModelUsage };
  // ...
};
```

## 6. UI展示层

### 6.1 状态栏显示

**文件**: [StatusLine.tsx](file:///workspace/src/components/StatusLine.tsx)

```typescript
// 构建状态栏命令输入
function buildStatusLineCommandInput(
  permissionMode: PermissionMode,
  exceeds200kTokens: boolean,
  settings: ReadonlySettings,
  messages: Message[],
  addedDirs: string[],
  mainLoopModel: ModelName,
  vimMode?: VimMode
): StatusLineCommandInput {
  const currentUsage = getCurrentUsage(messages);
  const contextWindowSize = getContextWindowForModel(runtimeModel, getSdkBetas());
  const contextPercentages = calculateContextPercentages(currentUsage, contextWindowSize);
  
  return {
    context_window: {
      total_input_tokens: getTotalInputTokens(),
      total_output_tokens: getTotalOutputTokens(),
      context_window_size: contextWindowSize,
      current_usage: currentUsage,
      used_percentage: contextPercentages.used,
      remaining_percentage: contextPercentages.remaining
    }
  };
}
```

### 6.2 /context 命令可视化

**文件**: [ContextVisualization.tsx](file:///workspace/src/components/ContextVisualization.tsx)

显示详细的上下文使用分解：

```typescript
interface ContextData {
  categories: ContextCategory[];
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  gridRows: GridSquare[][];
}
```

**可视化组件**：

```typescript
// 渲染上下文使用概览
<Box flexDirection="column">
  <Text bold={true}>Context Usage</Text>
  <Text dimColor={true}>
    {model} · {formatTokens(totalTokens)}/{formatTokens(rawMaxTokens)} 
    tokens ({percentage}%)
  </Text>
  
  {/* 分类详情 */}
  {categories.filter(cat => cat.tokens > 0).map(cat => (
    <Box>
      <Text color={cat.color}>{cat.symbol}</Text>
      <Text> {cat.name}: </Text>
      <Text dimColor={true}>
        {formatTokens(cat.tokens)} tokens ({percentDisplay})
      </Text>
    </Box>
  ))}
  
  {/* 网格可视化 */}
  {gridRows.map(row => (
    <Box flexDirection="row">
      {row.map(square => (
        <Text color={square.color}>{square.squareFullness >= 0.7 ? '●' : '○'}</Text>
      ))}
    </Box>
  ))}
</Box>
```

### 6.3 统计对话框

**文件**: [Stats.tsx](file:///workspace/src/components/Stats.tsx)

显示会话统计和历史数据：

```typescript
interface ClaudeCodeStats {
  totalSessions: number;
  totalTokens: number;
  modelUsage: { [model: string]: ModelUsage };
  dailyActivity: DailyActivity[];
  // ...
}
```

## 7. 完整数据流图

```
用户输入消息
    ↓
消息处理 (微压缩、规范化)
    ↓
API调用
    ↓
┌─────────────────────────────────────────────────────────────┐
│ API响应 (包含usage字段)                                      │
│ {                                                            │
│   input_tokens: number,                                     │
│   output_tokens: number,                                     │
│   cache_creation_input_tokens?: number,                      │
│   cache_read_input_tokens?: number                           │
│ }                                                            │
└─────────────────────────────────────────────────────────────┘
    ↓
消息存储 (usage嵌入assistant消息)
    ↓
┌─────────────────────────────────────────────────────────────┐
│ tokenCountWithEstimation(messages)                          │
│   1. 找到最后一条有usage的assistant消息                       │
│   2. 获取API返回的token总数                                  │
│   3. 估算新增消息的token数                                   │
│   4. 返回总估算值                                            │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ calculateContextPercentages(currentUsage, contextWindow)     │
│   percentage = (totalInputTokens / contextWindow) * 100     │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ UI展示                                                       │
│   - StatusLine: 显示百分比                                   │
│   - /context: 显示详细分解                                   │
│   - /stats: 显示历史统计                                     │
└─────────────────────────────────────────────────────────────┘
```

## 8. 关键代码路径

### 8.1 上下文百分比计算

```
用户输入
  → query.ts (消息处理)
    → tokens.ts:getCurrentUsage() (提取API usage)
      → context.ts:calculateContextPercentages() (计算百分比)
        → StatusLine.tsx (显示)
```

### 8.2 上下文分析详细分解

```
/context 命令
  → context.tsx:call() (命令入口)
    → analyzeContext.ts:analyzeContextUsage() (主分析函数)
      → countSystemTokens() (系统提示词)
      → countMemoryFileTokens() (CLAUDE.md文件)
      → countBuiltInToolTokens() (内置工具)
      → countMcpToolTokens() (MCP工具)
      → countCustomAgentTokens() (自定义agents)
      → countSkillTokens() (技能)
      → approximateMessageTokens() (对话消息)
        → ContextVisualization.tsx (渲染可视化)
```

### 8.3 成本追踪

```
API响应
  → cost-tracker.ts:addToTotalSessionCost()
    → 按模型累加 usage
      → 存储到 bootstrap/state.ts:modelUsage
        → Stats.tsx (显示统计)
```

## 9. 重要实现细节

### 9.1 并行工具调用的Token计数

当模型在单次响应中发起多个并行工具调用时：

```typescript
// messages数组结构：
// [..., assistant(id=A), user(result), assistant(id=A), user(result), ...]

// tokenCountWithEstimation处理：
// 1. 找到最后一条有usage的assistant消息
// 2. 遍历回溯找到第一个相同id的消息
// 3. 确保所有interleaved工具结果都被计入估算
```

### 9.2 缓存Token的处理

```typescript
// 总Token数 = input + cache_creation + cache_read + output
function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  );
}
```

### 9.3 自动压缩缓冲区

```typescript
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

// 有效上下文窗口 = 原始窗口 - 预留输出空间
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY  // 20,000
  );
  return getContextWindowForModel(model) - reservedTokensForSummary;
}
```

## 10. 相关文件索引

| 文件路径 | 职责 |
|---------|------|
| [tokenEstimation.ts](file:///workspace/src/services/tokenEstimation.ts) | Token计数核心实现 |
| [tokens.ts](file:///workspace/src/utils/tokens.ts) | 从消息提取usage数据 |
| [context.ts](file:///workspace/src/utils/context.ts) | 上下文窗口管理 |
| [analyzeContext.ts](file:///workspace/src/utils/analyzeContext.ts) | 上下文使用分析 |
| [cost-tracker.ts](file:///workspace/src/cost-tracker.ts) | 成本追踪 |
| [StatusLine.tsx](file:///workspace/src/components/StatusLine.tsx) | 状态栏UI |
| [ContextVisualization.tsx](file:///workspace/src/components/ContextVisualization.tsx) | 上下文可视化 |
| [Stats.tsx](file:///workspace/src/components/Stats.tsx) | 统计对话框 |
| [context.tsx](file:///workspace/src/commands/context/context.tsx) | /context命令入口 |
| [bootstrap/state.ts](file:///workspace/src/bootstrap/state.ts) | 全局状态管理 |
| [autoCompact.ts](file:///workspace/src/services/compact/autoCompact.ts) | 自动压缩逻辑 |
| [query.ts](file:///workspace/src/query.ts) | 查询循环 |

## 11. 总结

Token统计和上下文用量统计系统通过分层架构实现：

1. **数据采集层**：通过Anthropic API的usage字段获取精确token数据
2. **数据提取层**：从消息历史中提取和累积usage数据
3. **计算层**：结合API数据和本地估算计算当前上下文使用情况
4. **分析层**：按类别详细分解上下文使用
5. **展示层**：通过状态栏、命令和对话框多维度展示给用户

整个系统设计考虑了准确性（API数据）、实时性（流式更新）、和完整性（按类别分解）的平衡。
