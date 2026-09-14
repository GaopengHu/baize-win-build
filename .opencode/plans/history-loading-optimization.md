# 历史对话加载性能优化计划

## 问题分析

### 当前性能瓶颈

通过数据库分析发现：

| 会话 | 消息数 | 总内容 | 大消息(>10KB) | 最大消息 |
|------|--------|--------|---------------|----------|
| 896fd38f | 409 | 584KB | 9 | 30KB |
| 3cc5f276 | 112 | 274KB | 12 | 34KB |
| af68c881 | 82 | 130KB | 6 | 20KB |

**性能瓶颈点：**

1. **数据库查询** (`session-manager.ts:1201`)
   - `SELECT * FROM messages WHERE session_id = ?` 一次性加载全部消息
   - 无分页，无限制，409 条消息 = 584KB 数据

2. **JSON 解析** (`session-manager.ts:1217`)
   - 每条消息的 `content` 字段都要 `JSON.parse()`
   - 409 条消息 × ~1.4KB 平均 = 解析数百 KB 的 JSON
   - 大消息包含完整代码文件(30KB)、二进制数据(34KB)

3. **Token 统计解析** (`session-manager.ts:1208`)
   - 每条消息的 `token_usage` 都要 `JSON.parse()`

4. **内容清理** (`session-manager.ts:1206`)
   - `sanitizeContentBlocks()` 同步处理每条消息

5. **大消息内容**
   - 20-34KB 的消息包含完整 Python 脚本、ZIP 文件、详细分析
   - 即使不可见也会被完整解析和处理

### 性能影响

- **首次加载**：数据库查询 + JSON 解析 + 内容处理 = **数百毫秒**
- **后续加载**：缓存命中，**几毫秒**
- **缓存限制**：100 个会话，频繁切换导致重新加载

---

## 优化方案

### Phase 1: 延迟解析（低风险，高收益）

**目标**：将 JSON 解析推迟到实际需要时，减少初始加载开销

#### 1.1 延迟 content 解析

**当前代码** (`session-manager.ts:1202-1210`)：
```typescript
const messages = rows.map((row) => ({
  id: row.id,
  sessionId: row.session_id,
  role: row.role as Message['role'],
  content: this.sanitizeContentBlocks(this.normalizeContent(row.content)), // 立即解析
  timestamp: row.timestamp,
  tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : undefined,    // 立即解析
  executionTimeMs: row.execution_time_ms ?? undefined,
}));
```

**优化方案**：
```typescript
interface LazyMessage extends Message {
  _rawContent?: string;      // 原始 JSON 字符串
  _rawTokenUsage?: string;   // 原始 JSON 字符串
  _contentParsed?: boolean;
}

const messages: LazyMessage[] = rows.map((row) => ({
  id: row.id,
  sessionId: row.session_id,
  role: row.role as Message['role'],
  content: [],  // 空数组占位
  timestamp: row.timestamp,
  tokenUsage: undefined,  // 不解析
  executionTimeMs: row.execution_time_ms ?? undefined,
  _rawContent: row.content,           // 保存原始数据
  _rawTokenUsage: row.token_usage,    // 保存原始数据
  _contentParsed: false,
}));
```

**延迟解析方法**：
```typescript
private ensureMessageParsed(message: LazyMessage): Message {
  if (message._contentParsed) return message;
  
  message.content = this.sanitizeContentBlocks(this.normalizeContent(message._rawContent!));
  message.tokenUsage = message._rawTokenUsage ? JSON.parse(message._rawTokenUsage) : undefined;
  message._contentParsed = true;
  
  // 清理原始数据释放内存
  delete message._rawContent;
  delete message._rawTokenUsage;
  
  return message;
}
```

**使用场景**：
- UI 渲染时：只解析可见消息
- 发送给 LLM 时：解析所有消息
- 搜索/过滤时：按需解析

**预期收益**：
- 首次加载时间减少 **60-80%**（409 条消息只解析 0 条）
- 内存占用减少 **70%**（未解析的消息只存储原始字符串）

#### 1.2 按需清理内容

**当前**：`sanitizeContentBlocks()` 在加载时处理所有消息

**优化**：只在解析时清理，未解析的消息不清理

**预期收益**：减少 **30%** 初始加载时间

---

### Phase 2: 分页加载（中风险，高收益）

**目标**：只加载可见消息，滚动时加载更多

#### 2.1 数据库分页查询

**新增方法** (`database.ts`)：
```typescript
getMessagesPaginated: (sessionId: string, limit: number, offset: number) => {
  const stmt = rawDb.prepare(`
    SELECT * FROM messages 
    WHERE session_id = ? 
    ORDER BY timestamp ASC 
    LIMIT ? OFFSET ?
  `);
  return stmt.all(sessionId, limit, offset) as MessageRow[];
}
```

#### 2.2 会话管理器分页接口

**新增方法** (`session-manager.ts`)：
```typescript
getMessagesPaginated(
  sessionId: string, 
  page: number, 
  pageSize: number = 50
): { messages: Message[], total: number, hasMore: boolean } {
  const offset = page * pageSize;
  const rows = this.db.messages.getMessagesPaginated(sessionId, pageSize, offset);
  
  // 获取总数（缓存）
  const total = this.getSessionMessageCount(sessionId);
  
  const messages = rows.map(row => this.rowToLazyMessage(row));
  
  return {
    messages,
    total,
    hasMore: offset + pageSize < total,
  };
}

private sessionMessageCounts: Map<string, number> = new Map();

private getSessionMessageCount(sessionId: string): number {
  const cached = this.sessionMessageCounts.get(sessionId);
  if (cached !== undefined) return cached;
  
  const count = this.db.messages.getCountBySessionId(sessionId);
  this.sessionMessageCounts.set(sessionId, count);
  return count;
}
```

#### 2.3 IPC 接口

**新增 IPC** (`main/index.ts`)：
```typescript
ipcMain.handle('session.getMessagesPaginated', async (event, sessionId, page, pageSize) => {
  return runWithLogContext(sessionId, null, async () => {
    return sessionManager.getMessagesPaginated(sessionId, page, pageSize);
  });
});
```

**前端调用** (`renderer/hooks/useIPC.ts`)：
```typescript
const loadSessionMessages = async (sessionId: string, page: number = 0) => {
  const result = await window.electronAPI.invoke(
    'session.getMessagesPaginated', 
    sessionId, 
    page, 
    50
  );
  return result;
};
```

#### 2.4 虚拟滚动集成

**修改 ChatView** (`renderer/components/ChatView.tsx`)：
- 使用虚拟滚动库（如 `react-window` 或 `@tanstack/react-virtual`）
- 只渲染可见区域的消息（~10-20 条）
- 滚动到底部时自动加载下一页

**预期收益**：
- 首次加载时间减少 **90%**（只加载 50 条 vs 409 条）
- 内存占用减少 **85%**（只保持可见消息在内存中）
- 滚动流畅度提升（虚拟滚动）

---

### Phase 3: 内容优化（中风险，中收益）

**目标**：减少存储的内容大小，加快解析速度

#### 3.1 大消息内容截断

**策略**：超过 10KB 的 tool_result 内容截断保存

**修改保存逻辑** (`session-manager.ts:1171`)：
```typescript
private truncateLargeContent(content: ContentBlock[]): ContentBlock[] {
  const MAX_CONTENT_SIZE = 10000; // 10KB
  
  return content.map(block => {
    if (block.type === 'tool_result' && block.content) {
      if (typeof block.content === 'string' && block.content.length > MAX_CONTENT_SIZE) {
        return {
          ...block,
          content: block.content.substring(0, MAX_CONTENT_SIZE) + 
                   `\n\n[... truncated ${block.content.length - MAX_CONTENT_SIZE} bytes]`,
          _truncated: true,
        };
      }
    }
    return block;
  });
}

// 在 saveMessage 中使用
content: JSON.stringify(this.truncateLargeContent(this.sanitizeContentBlocks(message.content))),
```

**预期收益**：
- 数据库大小减少 **40-60%**
- 解析时间减少 **50%**
- 历史对话仍可完整发送给 LLM（截断的是 tool_result，LLM 不需要完整文件内容）

#### 3.2 二进制内容外部存储

**策略**：二进制数据（ZIP、图片）存储到文件系统，数据库只保存引用

**修改保存逻辑**：
```typescript
private async extractBinaryContent(content: ContentBlock[], sessionId: string): Promise<ContentBlock[]> {
  const BINARY_THRESHOLD = 5000; // 5KB
  
  const results: ContentBlock[] = [];
  
  for (const block of content) {
    if (block.type === 'tool_result' && block.content) {
      if (typeof block.content === 'string' && 
          block.content.length > BINARY_THRESHOLD &&
          this.isBinaryContent(block.content)) {
        
        // 保存到文件
        const fileName = `${sessionId}_${block.toolUseId}_binary.dat`;
        const filePath = path.join(this.getBinaryDir(), fileName);
        await fs.promises.writeFile(filePath, block.content, 'binary');
        
        // 替换为引用
        results.push({
          ...block,
          content: `[Binary content saved to ${fileName}]`,
          _binaryFile: filePath,
        });
      } else {
        results.push(block);
      }
    } else {
      results.push(block);
    }
  }
  
  return results;
}

private isBinaryContent(content: string): boolean {
  // 检测是否为二进制内容（高比例的非 ASCII 字符）
  const nonAsciiCount = (content.match(/[^\x20-\x7E\n\r\t]/g) || []).length;
  return nonAsciiCount / content.length > 0.3; // 30% 以上非 ASCII
}
```

**预期收益**：
- 数据库大小减少 **60-80%**
- JSON 解析时间减少 **70%**
- 二进制内容仍可访问（从文件读取）

---

### Phase 4: 异步处理（高风险，高收益）

**目标**：将耗时操作移到 Worker 线程

#### 4.1 Worker 线程解析

**创建 Worker** (`main/workers/message-parser.ts`)：
```typescript
import { parentPort } from 'worker_threads';

parentPort?.on('message', (data) => {
  const { rows } = data;
  
  const messages = rows.map((row: any) => {
    let content: any[];
    try {
      const parsed = JSON.parse(row.content);
      content = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      content = [{ type: 'text', text: row.content }];
    }
    
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content,
      timestamp: row.timestamp,
      tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : undefined,
      executionTimeMs: row.execution_time_ms,
    };
  });
  
  parentPort?.postMessage({ messages });
});
```

**使用 Worker** (`session-manager.ts`)：
```typescript
import { Worker } from 'worker_threads';
import * as path from 'path';

private async parseMessagesInWorker(rows: MessageRow[]): Promise<Message[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.join(__dirname, 'workers/message-parser.js')
    );
    
    worker.on('message', (data) => {
      resolve(data.messages);
      worker.terminate();
    });
    
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker stopped with code ${code}`));
    });
    
    worker.postMessage({ rows });
  });
}

// 在 getMessages 中使用
const messages = await this.parseMessagesInWorker(rows);
```

**预期收益**：
- 主线程不阻塞，UI 保持响应
- 解析时间减少 **40%**（并行处理）
- 409 条消息解析不卡顿 UI

#### 4.2 后台预加载

**策略**：用户打开会话列表时，后台预加载最近 3 个会话

**实现**：
```typescript
private preloadRecentSessions(): void {
  const recentSessions = this.getRecentSessions(3);
  
  for (const session of recentSessions) {
    // 异步加载，不阻塞
    this.getMessages(session.id).catch(err => {
      log('[SessionManager] Preload failed:', session.id, err);
    });
  }
}

// 在会话列表加载时调用
getSessions(): Session[] {
  const sessions = this.db.sessions.list();
  
  // 后台预加载
  setImmediate(() => this.preloadRecentSessions());
  
  return sessions;
}
```

**预期收益**：
- 用户打开最近会话时 **0 延迟**（已预加载）
- 首次加载体验提升 **100%**

---

## 实施优先级

| 阶段 | 方案 | 风险 | 收益 | 工时 | 优先级 |
|------|------|------|------|------|--------|
| 1.1 | 延迟 content 解析 | 低 | 高 | 2h | **P0** |
| 1.2 | 按需清理内容 | 低 | 中 | 1h | **P0** |
| 2.1-2.4 | 分页加载 | 中 | 高 | 8h | **P1** |
| 3.1 | 大消息截断 | 中 | 中 | 2h | **P1** |
| 3.2 | 二进制外部存储 | 中 | 高 | 4h | **P2** |
| 4.1 | Worker 线程 | 高 | 高 | 4h | **P2** |
| 4.2 | 后台预加载 | 低 | 中 | 2h | **P2** |

---

## 预期效果

### 当前性能（409 条消息，584KB）

| 操作 | 耗时 |
|------|------|
| 首次加载 | 300-500ms |
| 后续加载 | 5-10ms（缓存） |
| 内存占用 | ~2MB |

### Phase 1 后（延迟解析）

| 操作 | 耗时 | 改进 |
|------|------|------|
| 首次加载 | 50-100ms | **-80%** |
| 后续加载 | 5-10ms | 无变化 |
| 内存占用 | ~600KB | **-70%** |

### Phase 1 + 2 后（延迟 + 分页）

| 操作 | 耗时 | 改进 |
|------|------|------|
| 首次加载 | 30-50ms | **-90%** |
| 加载下一页 | 20-30ms | 新增 |
| 后续加载 | 5-10ms | 无变化 |
| 内存占用 | ~300KB | **-85%** |

### 全部完成后

| 操作 | 耗时 | 改进 |
|------|------|------|
| 首次加载 | 20-40ms | **-93%** |
| 加载下一页 | 15-25ms | 新增 |
| 后续加载 | 5-10ms | 无变化 |
| 打开最近会话 | 0ms（预加载） | **-100%** |
| 内存占用 | ~200KB | **-90%** |

---

## 风险与缓解

### Phase 1 风险

**风险**：延迟解析可能影响依赖完整消息的逻辑

**缓解**：
- 提供 `ensureMessageParsed()` 方法确保需要时可获取完整数据
- 在发送给 LLM、搜索、导出等场景自动调用
- 单元测试覆盖所有使用场景

### Phase 2 风险

**风险**：分页可能影响消息搜索、跳转等功能的完整性

**缓解**：
- 提供 `getMessagesPaginated()` 和 `getMessages()` 两种接口
- 搜索功能使用数据库查询，不依赖内存中的消息
- 跳转到特定消息时自动加载对应页面

### Phase 3 风险

**风险**：截断大消息可能影响 LLM 的上下文理解

**缓解**：
- 只截断 tool_result（文件内容），保留 tool_use（完整代码）
- 截断时添加 `[... truncated]` 标记
- LLM 通常不需要完整文件内容，摘要足够

### Phase 4 风险

**风险**：Worker 线程增加复杂性，可能引入新的 bug

**缓解**：
- Worker 失败时回退到主线程解析
- 充分的错误处理和日志
- 渐进式部署，先在开发环境验证

---

## 测试计划

### 性能测试

1. **加载时间测试**
   - 测试不同大小的会话（50、100、200、400 条消息）
   - 测量首次加载、后续加载、翻页加载时间
   - 对比优化前后的性能

2. **内存测试**
   - 使用 Chrome DevTools 测量内存占用
   - 测试打开多个会话时的内存增长
   - 验证缓存清理是否正常工作

3. **滚动性能测试**
   - 测试 400+ 条消息的滚动流畅度
   - 测量 FPS（目标：60 FPS）
   - 测试快速滚动时的加载延迟

### 功能测试

1. **消息完整性**
   - 验证所有消息都能正确显示
   - 验证消息顺序正确
   - 验证大消息（>10KB）正确显示

2. **搜索功能**
   - 验证搜索能找到所有匹配消息
   - 验证搜索结果能正确跳转

3. **LLM 交互**
   - 验证发送给 LLM 的消息完整
   - 验证 LLM 能正确理解历史对话
   - 验证工具调用历史完整

4. **导出功能**
   - 验证导出的对话包含所有消息
   - 验证导出格式正确

---

## 总结

历史对话加载过慢的核心问题是**一次性加载并解析所有消息**，对于 400+ 条消息的大会话，这导致：
- 数据库查询 584KB 数据
- 解析数百 KB 的 JSON
- 同步处理所有消息

通过分阶段优化：
1. **延迟解析**（P0）：减少 80% 首次加载时间
2. **分页加载**（P1）：再减少 50% 加载时间，支持虚拟滚动
3. **内容优化**（P2）：减少数据库大小和解析时间
4. **异步处理**（P2）：不阻塞 UI，后台预加载

预期最终效果：
- 首次加载时间从 300-500ms 降到 **20-40ms**（**-93%**）
- 内存占用从 2MB 降到 **200KB**（**-90%**）
- 打开最近会话 **0 延迟**（预加载）

建议按 P0 → P1 → P2 的顺序逐步实施，每个阶段完成后进行性能测试验证效果。
