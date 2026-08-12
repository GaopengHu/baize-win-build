# 白泽稳定性修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 修复白泽应用使用中出现的 "Session manager not initialized" 错误、模型回退合成模式问题，以及 MemoryService 超时过长问题。

**架构:** 三部分独立修复：(1) 为 `ipcMain.on()` 添加防重复注册保护；(2) 在 pi-ai 模型解析层添加 `zhipuai` → `zai` 提供商别名映射；(3) 降低 MemoryService 默认超时时间。每个修复互不依赖，可独立验证。

**Tech Stack:** Electron 22, TypeScript, ipcMain, pi-ai, Vite/Rollup

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/main/index.ts` | 修改 (L1189 附近) | 为 `ipcMain.on()` 添加与 `ipcMain.handle()` 一致的防重复注册包装 |
| `src/main/claude/pi-model-resolution.ts` | 修改 | 添加提供商别名映射 `zhipuai` → `zai`，使 `zhipuai/glm-5` 能命中 pi-ai 注册表 |
| `src/main/config/config-store.ts` | 修改 (L256) | 降低 `memoryRuntime.llm.timeoutMs` 默认值 180000 → 30000 |

---

### Task 1: 为 `ipcMain.on()` 添加防重复注册保护

**问题:** `src/main/index.ts:1189` 的 `ipcMain.on('client-event', ...)` 没有与 `ipcMain.handle()` 相同的防重复注册保护。当模块通过 provider chunks 被加载两次时，会注册两个 listener。第二个 listener 使用未初始化的 `sessionManager`（null），导致 "Session manager not initialized" 错误被发送到 UI。

`ipcMain.on()` 与 `ipcMain.handle()` 不同：handle 在重复注册时抛出异常（可被 catch），而 on 静默添加第二个 listener。因此需要用 Set 追踪已注册的 channel。

**Files:**
- Modify: `src/main/index.ts:1172-1187`（在现有 ipcMain.handle 包装器之后，ipcMain.on 调用之前插入 ipcMain.on 包装器）

- [ ] **Step 1: 在 `ipcMain.handle` 包装器之后、`ipcMain.on('client-event')` 之前插入 `ipcMain.on` 包装器**

  **Context:** 现有代码在 `src/main/index.ts` 第 1172-1187 行有 `ipcMain.handle` 的包装器，紧随其后第 1189 行是 unprotected 的 `ipcMain.on('client-event', ...)`。

  在 `src/main/index.ts` 第 1187 行（`}) as typeof ipcMain.handle;` 之后）、第 1189 行（`ipcMain.on('client-event', ...)` 之前）插入：

  ```typescript
  // Also guard ipcMain.on() — unlike ipcMain.handle, Electron silently allows
  // duplicate listeners, so we must track registered channels explicitly.
  const __originalIpcOn = ipcMain.on.bind(ipcMain);
  const __ipcOnRegisteredChannels = new Set<string>();
  ipcMain.on = ((channel: string, listener: (...args: any[]) => any) => {
    if (!__ipcOnRegisteredChannels.has(channel)) {
      __ipcOnRegisteredChannels.add(channel);
      __originalIpcOn(channel, listener);
    }
  }) as typeof ipcMain.on;
  ```

  插入后代码段变为（第 1172-1195 行）：

  ```typescript
  // IPC Handlers
  // Guard: Vite code splitting can duplicate this module in shared chunks,
  // causing duplicate ipcMain.handle() registrations. Wrapping the original
  // method to make it idempotent prevents the "second handler" error.
  const __originalIpcHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: (...args: any[]) => any) => {
    try {
      __originalIpcHandle(channel, listener);
    } catch (e: any) {
      if (e?.message?.includes?.('register a second handler')) {
        // Already registered — expected with Vite code splitting, safe to ignore
      } else {
        throw e;
      }
    }
  }) as typeof ipcMain.handle;

  // Also guard ipcMain.on() — unlike ipcMain.handle, Electron silently allows
  // duplicate listeners, so we must track registered channels explicitly.
  const __originalIpcOn = ipcMain.on.bind(ipcMain);
  const __ipcOnRegisteredChannels = new Set<string>();
  ipcMain.on = ((channel: string, listener: (...args: any[]) => any) => {
    if (!__ipcOnRegisteredChannels.has(channel)) {
      __ipcOnRegisteredChannels.add(channel);
      __originalIpcOn(channel, listener);
    }
  }) as typeof ipcMain.on;

  ipcMain.on('client-event', async (_event, data: ClientEvent) => {
    try {
      await handleClientEvent(data);
    } catch (error) {
      logError('Error handling client event:', error);
      sendToRenderer({
        type: 'error',
        payload: { message: error instanceof Error ? error.message : 'Unknown error' },
      });
    }
  });
  ```

- [ ] **Step 2: 验证变更正确性**

  运行编译检查确保 TypeScript 无类型错误：

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  预期输出: 无类型错误（或仅不相关警告）。

- [ ] **Step 3: 验证 Vite 构建**

  ```bash
  npx vite build 2>&1 | tail -10
  ```

  预期: Build 成功，产出的 `dist-electron/main/index-Db4li3q-.js` 包含新的 `ipcMain.on` 包装器代码。

  ```bash
  grep -c '__ipcOnRegisteredChannels' dist-electron/main/index-Db4li3q-.js
  ```

  预期输出: `1`（确认新代码被打包进去）

- [ ] **Step 4: Commit**

  ```bash
  git add src/main/index.ts
  git commit -m "fix: guard ipcMain.on() against duplicate registration from code-split chunks

  ipcMain.on() is NOT protected by the existing ipcMain.handle() wrapper
  (which catches 'register a second handler' errors). Unlike ipcMain.handle(),
  ipcMain.on() silently allows duplicate listeners — so each code-split chunk
  load adds another listener. The second listener uses a null sessionManager
  (module-level variable from the duplicate load), causing 'Session manager
  not initialized' errors sent to the UI.

  Fix: wrap ipcMain.on() with a Set-based dedup guard, tracking already-
  registered channels. Only the first registration is forwarded to Electron."
  ```

---

### Task 2: 添加模型提供商别名映射 `zhipuai` → `zai`

**问题:** 用户在配置中使用 `zhipuai/glm-5` 作为模型名称，但 pi-ai 的注册表中 `glm-5` 注册在 `zai` 提供商下。`resolvePiRegistryModel("zhipuai/glm-5")` 依次尝试 `(zhipuai, glm-5)`、`(anthropic, glm-5)`、`(openai, glm-5)`、`(google, glm-5)` 均未命中，回退到合成模式（synthetic model），丢失 `thinkingFormat: "zai"`、cost tracking、正确的 contextWindow 等元信息。

**Files:**
- Modify: `src/main/claude/pi-model-resolution.ts`（在 `buildPiModelLookupCandidates` 中添加别名映射）

- [ ] **Step 1: 阅读 `buildPiModelLookupCandidates` 函数**

  确认函数签名和当前候选生成逻辑：

  文件: `src/main/claude/pi-model-resolution.ts`，约第 234 行左右。

  函数会解析 modelString，提取 `parsedProvider` 和 `parsedModelId`，然后生成候选列表。

- [ ] **Step 2: 添加提供商别名映射**

  在 `buildPiModelLookupCandidates` 函数内、解析 `parsedProvider` 之后，添加别名归一化逻辑。

  在 `parsedProvider` 赋值之后、候选列表生成之前插入：

  ```typescript
  // Provider alias mapping: normalize known aliases to pi-ai canonical names.
  // This allows users to use familiar provider names (e.g., "zhipuai")
  // while still hitting the pi-ai model registry entries (e.g., "zai").
  const PROVIDER_ALIASES: Record<string, string> = {
    'zhipuai': 'zai',
  };
  const canonicalProvider = PROVIDER_ALIASES[parsedProvider] || parsedProvider;
  ```

  并将后续所有 `parsedProvider` 引用改为 `canonicalProvider`。具体来说，候选列表生成中第一个候选的 provider 应使用 `canonicalProvider`。

  修改后的关键代码段（约第 234-260 行）伪代码示意：

  ```typescript
  export function buildPiModelLookupCandidates(
    modelString: string,
    options: PiModelLookupOptions = {}
  ): PiModelLookupCandidate[] {
    const candidates: PiModelLookupCandidate[] = [];
    const parts = modelString.split('/');

    // Provider alias mapping
    const PROVIDER_ALIASES: Record<string, string> = {
      'zhipuai': 'zai',
    };

    if (parts.length >= 2) {
      const parsedProvider = parts[0];
      const parsedModelId = parts.slice(1).join('/');
      const canonicalProvider = PROVIDER_ALIASES[parsedProvider] || parsedProvider;

      // Try canonical provider first (or parsedProvider if no alias)
      candidates.push({ provider: canonicalProvider, model: parsedModelId });

      // If alias was applied, also try the original name as fallback
      if (canonicalProvider !== parsedProvider) {
        candidates.push({ provider: parsedProvider, model: parsedModelId });
      }
      // ... rest of existing candidat generation ...
    }
    // ...
  }
  ```

  > **注意**: 由于需要保留原有 fallback 链逻辑，实际修改应以不破坏现有行为为前提，仅在 parsedProvider 后追加 canonicalProvider 的候选条目。

- [ ] **Step 3: 验证变更正确性**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  预期: 无类型错误。

- [ ] **Step 4: 验证构建**

  ```bash
  npx vite build 2>&1 | tail -10
  ```

  构建成功。

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/claude/pi-model-resolution.ts
  git commit -m "fix: add provider alias zhipuai -> zai for pi-ai model registry lookup

  pi-ai's built-in model registry has glm-5 registered under provider 'zai',
  but users configure 'zhipuai/glm-5'. The model string 'zhipuai/glm-5' fails
  all registry lookups (no 'zhipuai' provider exists) and falls back to
  synthetic mode, losing thinkingFormat, cost tracking, and proper context window.

  Fix: add a provider alias mapping 'zhipuai' -> 'zai' in
  buildPiModelLookupCandidates(), so the canonicalized provider is tried first
  while retaining the original as fallback."
  ```

---

### Task 3: 降低 MemoryService LLM 默认超时

**问题:** MemoryService 的 LLM 调用默认超时 180 秒（`config-store.ts:256`）。当 API 代理不可达时，每次内存摄取会阻塞 3 分钟才超时失败，严重影响用户体验。

**Files:**
- Modify: `src/main/config/config-store.ts`（第 256 行附近的默认配置）

- [ ] **Step 1: 修改 `memoryRuntime.llm.timeoutMs` 默认值**

  文件 `src/main/config/config-store.ts` 第 248-276 行的 `defaultConfig` 中：

  将：
  ```typescript
  timeoutMs: 180000,
  ```
  改为：
  ```typescript
  timeoutMs: 30000,
  ```

  同样也对 `memoryRuntime.embedding.timeoutMs` 做相同修改：
  ```typescript
  timeoutMs: 30000,
  ```

  这使得超时从 3 分钟降到 30 秒，同时仍然给正常请求留有足够时间（多数 LLM 调用在 5-15 秒内完成）。

- [ ] **Step 2: 验证构建**

  ```bash
  npx vite build 2>&1 | tail -10
  ```

  构建成功。

- [ ] **Step 3: Commit**

  ```bash
  git add src/main/config/config-store.ts
  git commit -m "fix: reduce memory LLM default timeout from 180s to 30s

  When the API proxy is unreachable, MemoryService memory ingestion blocks
  for 180 seconds before timing out. Reducing the default to 30s provides
  faster failure recovery while still accommodating normal LLM response times."
  ```

---

### 验证与构建

- [ ] **Step 1: 完整编译检查**

  ```bash
  npx tsc --noEmit && npx vite build
  ```

- [ ] **Step 2: 将三个 commit 推到分支**

  ```bash
  git log --oneline -5
  ```

---

## 自检

**1. Spec 覆盖:**
- Task 1 → "Session manager not initialized" 修复 ✓
- Task 2 → 模型未注册回退合成模式修复 ✓
- Task 3 → MemoryService 超时优化 ✓

**2. 占位符检查:** 所有步骤包含实际代码内容和验证命令。无 "TBD"、"TODO" 等。

**3. 类型一致性:**
- `__originalIpcOn` 类型与 `ipcMain.on` 一致 ✓
- `__ipcOnRegisteredChannels` 是 `Set<string>` ✓
- `PROVIDER_ALIASES` 是 `Record<string, string>` ✓
- `timeoutMs` 已从 180000→30000，类型仍为 number ✓
