# Claude 桌面程序图片附件处理流程

## GitHub 参考仓库

本项目代码基于：[hjdspace/claude-code-haha](https://github.com/hjdspace/claude-code-haha)

## 整体架构

### 1. 前端处理（Desktop）

**位置**：[ChatInput.tsx:652-678](file:///workspace/desktop/src/components/chat/ChatInput.tsx#L652-L678)

前端使用 **FileReader API** 将图片读取为 **Base64 data URL**：

```typescript
const reader = new FileReader()
reader.onload = () => {
  setAttachments((prev) => [
    ...prev,
    {
      id,
      name: file.name,
      type: 'image',        // 或 'file'
      mimeType: file.type,  // 如 'image/png'
      previewUrl: reader.result as string,  // Base64 data URL
      data: reader.result as string,        // Base64 data URL
    },
  ])
}
reader.readAsDataURL(file)  // 关键：转换为 data:image/png;base64,... 格式
```

支持三种方式添加图片：
- **粘贴**：从剪贴板粘贴图片
- **文件选择**：通过文件对话框选择
- **拖拽**：将图片拖入输入框

### 2. 后端预处理（Server）

**位置**：[conversationService.ts:1325-1364](file:///workspace/src/server/services/conversationService.ts#L1325-L1364)

后端收到 base64 数据后，进行以下**预处理**：

```typescript
private materializeAttachments(sessionId: string, attachments?: AttachmentRef[]): string {
  const uploadDir = path.join(
    process.env.CLAUDE_CONFIG_DIR || '~/.claude',
    'uploads',
    sessionId
  )
  fs.mkdirSync(uploadDir, { recursive: true })

  const savedPaths: string[] = []
  for (const attachment of attachments) {
    if (attachment.path) {
      // 已有路径的文件，直接使用
      savedPaths.push(attachment.path)
      continue
    }

    // Base64 解码并保存到临时文件
    const payload = this.parseAttachmentData(attachment.data)  // 解码 base64
    const outPath = path.join(uploadDir, `${crypto.randomUUID()}-${fileName}`)
    fs.writeFileSync(outPath, payload)  // 写入磁盘
    savedPaths.push(outPath)
  }

  // 生成 @-引用格式
  return savedPaths.map((filePath) => `@"${filePath}"`).join(' ') + ' '
}
```

**预处理步骤**：
1. **Base64 解码**：将 `data:image/png;base64,... 格式转换为二进制数据
2. **确定文件扩展名**：根据 MIME type 或文件名后缀确定
3. **生成唯一文件名**：使用 UUID 避免冲突
4. **写入临时目录**：`~/.claude/uploads/{sessionId}/
5. **清理文件扩展名**：移除非法字符

### 3. 传递给 CLI

**位置**：[conversationService.ts:1311-1322](file:///workspace/src/server/services/conversationService.ts#L1311-L1322)

```typescript
private buildUserContent(content: string, sessionId: string, attachments?: AttachmentRef[]): Array<Record<string, unknown>> {
  const prefix = this.materializeAttachments(sessionId, attachments)  // 返回 @"path1" @"path2"
  const text = prefix
    ? `${prefix}${trimmed || 'Please analyze the attached files.'}`.trim()
    : trimmed

  return [{ type: 'text', text }]
}
```

CLI 收到的消息格式类似：
```
@"~/.claude/uploads/{sessionId}/abc123-image.png" @"~/.claude/uploads/{sessionId}/def456-diagram.png" 请分析这些图片
```

## 完整流程图

```
┌─────────────────────────────────────────────────────────────────┐
│ 前端 (React Desktop App)                                         │
│                                                                  │
│ 用户选择图片                                                      │
│        ↓                                                         │
│ FileReader.readAsDataURL()  →  data:image/png;base64,ABC123...  │
│        ↓                                                         │
│ 存储到 React state (attachments[])                               │
│        ↓                                                         │
│ 发送 WebSocket 消息到 Server                                      │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 后端 (Server - conversationService)                              │
│                                                                  │
│ 接收 AttachmentRef[]                                             │
│        ↓                                                         │
│ parseAttachmentData()  →  Buffer.from(base64, 'base64')        │
│        ↓                                                         │
│ 生成 UUID 文件名 + 扩展名                                         │
│        ↓                                                         │
│ fs.writeFile()  →  ~/.claude/uploads/{sessionId}/{uuid}.png     │
│        ↓                                                         │
│ 返回文件路径列表                                                  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Claude CLI 子进程                                                │
│                                                                  │
│ 接收文本: @"~/.claude/uploads/.../xxx.png" 请分析               │
│        ↓                                                         │
│ CLI 解析 @-引用，读取文件内容                                     │
│        ↓                                                         │
│ Claude 处理图片内容                                               │
└─────────────────────────────────────────────────────────────────┘
```

## 总结

1. **前端**：使用 `FileReader.readAsDataURL()` 将图片转为 Base64 data URL
2. **后端**：
   - Base64 解码为二进制数据
   - 保存到临时目录 `~/.claude/uploads/{sessionId}/
   - 转换为 `@"文件路径"` 格式传给 CLI
3. **CLI**：通过 `@` 引用语法读取本地图片文件进行处理
4. **预处理**：主要做了格式转换（base64 → 文件）和临时存储，没有对图片进行压缩或裁剪

## 关键代码位置

- **前端图片处理**：
  - 本地：[desktop/src/components/chat/ChatInput.tsx:652-678](file:///workspace/desktop/src/components/chat/ChatInput.tsx#L652-L678)
  - GitHub：[desktop/src/components/chat/ChatInput.tsx#L652-L678](https://github.com/hjdspace/claude-code-haha/blob/main/desktop/src/components/chat/ChatInput.tsx#L652-L678)
- **后端附件处理**：
  - 本地：[src/server/services/conversationService.ts:1325-1364](file:///workspace/src/server/services/conversationService.ts#L1325-L1364)
  - GitHub：[src/server/services/conversationService.ts#L1325-L1364](https://github.com/hjdspace/claude-code-haha/blob/main/src/server/services/conversationService.ts#L1325-L1364)
- **用户内容构建**：
  - 本地：[src/server/services/conversationService.ts:1311-1322](file:///workspace/src/server/services/conversationService.ts#L1311-L1322)
  - GitHub：[src/server/services/conversationService.ts#L1311-L1322](https://github.com/hjdspace/claude-code-haha/blob/main/src/server/services/conversationService.ts#L1311-L1322)
- **AttachmentRef 类型**：
  - 本地：[src/server/services/conversationService.ts:31-36](file:///workspace/src/server/services/conversationService.ts#L31-L36)
  - GitHub：[src/server/services/conversationService.ts#L31-L36](https://github.com/hjdspace/claude-code-haha/blob/main/src/server/services/conversationService.ts#L31-L36)
