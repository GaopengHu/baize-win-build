import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const agentRunnerPath = path.resolve(process.cwd(), 'src/main/claude/agent-runner.ts');
const agentRunnerContent = readFileSync(agentRunnerPath, 'utf8');

// Phase 1 迁移：以下模块从 agent-runner.ts 拆出，源码文本断言随之指向新文件。
const pipelineUtilsPath = path.resolve(process.cwd(), 'src/main/claude/pipeline/utils.ts');
const pipelineUtilsContent = readFileSync(pipelineUtilsPath, 'utf8');
const mcpToolBridgePath = path.resolve(process.cwd(), 'src/main/claude/tools/mcp-tool-bridge.ts');
const mcpToolBridgeContent = readFileSync(mcpToolBridgePath, 'utf8');
// Phase 4 迁移：coworkAppendPrompt 内联数组移入 pipeline/prompt-strategy.ts，
// prompt 文本断言随之指向新文件（行为断言见 tests/claude/pipeline/prompt-strategy.test.ts）。
const promptStrategyPath = path.resolve(
  process.cwd(),
  'src/main/claude/pipeline/prompt-strategy.ts'
);
const promptStrategyContent = readFileSync(promptStrategyPath, 'utf8');

describe('ClaudeAgentRunner Open Cowork SDK integration', () => {
  it('avoids dynamic re-import shadowing for config store singletons', () => {
    expect(agentRunnerContent).toContain(
      "import { mcpConfigStore } from '../mcp/mcp-config-store'"
    );
    expect(agentRunnerContent).not.toContain(
      "const { configStore } = await import('../config/config-store')"
    );
    expect(agentRunnerContent).not.toContain(
      "const { mcpConfigStore } = await import('../mcp/mcp-config-store')"
    );
    // mcp-tool-bridge（Phase 1 拆出）同样必须走静态 import，不得动态 re-import 单例
    expect(mcpToolBridgeContent).toContain(
      "import type { MCPManager } from '../../mcp/mcp-manager'"
    );
    expect(mcpToolBridgeContent).not.toContain('await import(');
  });

  it('keeps MCP config build resilient', () => {
    // safeStringify 已迁至 pipeline/utils.ts（Phase 1）
    expect(pipelineUtilsContent).toContain('export function safeStringify');
    expect(agentRunnerContent).toContain("from './pipeline/utils'");
    expect(agentRunnerContent).toContain('Failed to prepare MCP server config, skipping server');
  });

  it('uses standard markdown link guidance for sources citations', () => {
    // Phase 4 迁移：citation_requirements 段移入 prompt-strategy.ts
    expect(promptStrategyContent).toContain(
      'otherwise use standard Markdown links: [Title](https://claude.ai/chat/URL)'
    );
  });

  it('avoids duplicating the current user prompt in contextual history assembly', () => {
    expect(agentRunnerContent).toContain('const conversationMessages = existingMessages');
    // Image-containing messages are filtered out individually (not skipping entire history)
    expect(agentRunnerContent).toContain('const textOnlyMessages = conversationMessages');
    expect(agentRunnerContent).toContain('textOnlyMessages.slice(0, -1)');
    expect(agentRunnerContent).toContain(
      "textOnlyMessages[textOnlyMessages.length - 1]?.role === 'user'"
    );
  });

  it('keeps MCP server logging compact unless full debug logging is enabled', () => {
    expect(agentRunnerContent).toContain("log('[ClaudeAgentRunner] Final mcpServers summary:'");
    expect(agentRunnerContent).toContain("if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {");
    expect(agentRunnerContent).toContain("log('[ClaudeAgentRunner] Final mcpServers config:'");
  });

  it('summarizes noisy SDK message updates instead of logging every text delta', () => {
    expect(agentRunnerContent).toContain('const streamEventCounts = new Map<string, number>();');
    expect(agentRunnerContent).toContain(
      "if (updateType !== 'text_delta' && updateType !== 'thinking_delta') {"
    );
    expect(agentRunnerContent).toContain('[ClaudeAgentRunner] Event: message_end [api_call #');
    expect(agentRunnerContent).toContain('messageUpdateCounts: getStreamEventSummary()');
    expect(agentRunnerContent).toContain("if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {");
    expect(agentRunnerContent).toContain("'[ClaudeAgentRunner] message_end raw message:'");
  });

  it('reuses the shared user-facing error helper', () => {
    expect(agentRunnerContent).toContain("from './agent-runner-message-end'");
    expect(agentRunnerContent).toContain('resolveMessageEndPayload');
    expect(agentRunnerContent).toContain('toUserFacingErrorText');
    expect(agentRunnerContent).toContain(
      'const errorText = toUserFacingErrorText(toErrorText(error));'
    );
  });

  it('uses pi DefaultResourceLoader with additionalSkillPaths and appendSystemPrompt', () => {
    expect(agentRunnerContent).toContain('additionalSkillPaths: skillPaths');
    expect(agentRunnerContent).toContain('appendSystemPrompt: coworkAppendPrompt');
    expect(agentRunnerContent).not.toContain('systemPromptOverride');
  });

  it('recreates cached pi sessions when the runtime signature changes', () => {
    expect(agentRunnerContent).toContain(
      "import { buildPiSessionRuntimeSignature } from './pi-session-runtime'"
    );
    expect(agentRunnerContent).toContain(
      'const sessionRuntimeSignature = buildPiSessionRuntimeSignature({'
    );
    expect(agentRunnerContent).toContain(
      'cachedSession.runtimeSignature !== sessionRuntimeSignature'
    );
    expect(agentRunnerContent).toContain('Runtime changed, recreating cached pi session:');
    expect(agentRunnerContent).toContain('runtimeSignature: sessionRuntimeSignature');
  });

  it('uses the normalized route protocol so openrouter follows the openai-compatible path', () => {
    expect(agentRunnerContent).toContain('resolvePiRouteProtocol');
    expect(agentRunnerContent).toContain('const configProtocol = resolvePiRouteProtocol(');
    expect(agentRunnerContent).toContain('resolveSyntheticPiModelFallback');
  });

  it('nudges the model to proceed with reasonable assumptions', () => {
    // Phase 4 迁移：base rules 移入 prompt-strategy.ts
    expect(promptStrategyContent).toContain('proceed immediately with reasonable assumptions');
    expect(promptStrategyContent).toContain('within two days');
    expect(promptStrategyContent).toContain('most recent two relevant publication days');
  });

  it('routes MCP image results through structured helpers instead of stringifying base64 into text', () => {
    // Phase 1 迁移：buildMcpCustomTools（含 normalizeMcpToolResultForModel 调用）
    // 移入 tools/mcp-tool-bridge.ts；UI 侧 normalizeToolExecutionResultForUi 留在 agent-runner。
    expect(mcpToolBridgeContent).toContain(
      "import { normalizeMcpToolResultForModel } from '../tool-result-utils'"
    );
    expect(mcpToolBridgeContent).toContain(
      'const normalizedResult = normalizeMcpToolResultForModel(result);'
    );
    expect(agentRunnerContent).toContain(
      "import { normalizeToolExecutionResultForUi } from './tool-result-utils'"
    );
    expect(agentRunnerContent).toContain(
      'const normalizedToolResult = normalizeToolExecutionResultForUi(event.result);'
    );
    expect(agentRunnerContent).not.toContain('else textParts.push(JSON.stringify(part));');
    expect(agentRunnerContent).not.toContain(": JSON.stringify(event.result || '');");
    expect(mcpToolBridgeContent).not.toContain('JSON.stringify(result');
  });

  it('persists assistant model metadata for pi-ai thinking replay', () => {
    expect(agentRunnerContent).toContain('api: piModel.api');
    expect(agentRunnerContent).toContain('provider: piModel.provider');
    expect(agentRunnerContent).toContain('model: piModel.id');
  });

  it('does not reference removed AskUserQuestion or TodoWrite tools', () => {
    expect(agentRunnerContent).not.toContain('AskUserQuestion');
    expect(agentRunnerContent).not.toContain('TodoWrite');
    expect(agentRunnerContent).not.toContain('pendingQuestions');
    // Phase 4：prompt 文本现居 prompt-strategy.ts，反向断言同步指向新文件
    expect(promptStrategyContent).not.toContain('AskUserQuestion');
    expect(promptStrategyContent).not.toContain('TodoWrite');
    expect(promptStrategyContent).not.toContain('pendingQuestions');
  });

  it('chat-first behavioral rules are present', () => {
    // Phase 4 迁移：CHAT FIRST / START DOING IT 规则移入 prompt-strategy.ts
    expect(promptStrategyContent).toContain('CHAT FIRST');
    expect(promptStrategyContent).toContain(
      'Do NOT create, write, or edit files unless the user explicitly asks'
    );
    expect(promptStrategyContent).toContain('START DOING IT');
  });
});
