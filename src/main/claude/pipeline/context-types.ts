/**
 * @module main/claude/pipeline/context-types
 *
 * Pipeline 各 Stage 之间流转的共享类型定义
 * （AGENT-RUNNER-REFACTOR-PLAN.md §2.3）。
 *
 * Stage 1 产出 ModelContext → Stage 2 分类 + 三策略 → Stage 3 Session 工厂。
 * Phase 1 先落地类型与 estimateCharsPerToken 纯函数；
 * Phase 4/5 的策略与工厂模块开始消费这些类型。
 */
import type { Api, Model } from '@mariozechner/pi-ai';
import type {
  AgentSession as PiAgentSession,
  AuthStorage,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import type { AppConfig } from '../../config/config-store';
import type { Message } from '../../../renderer/types';

// ═══ Stage 1 输出：模型解析结果 ═══
export interface ModelContext {
  piModel: Model<Api>;
  provider: string;
  configProtocol: string;
  contextWindow: number;
  authStorage: AuthStorage;
  runtimeConfig: AppConfig;
}

// ═══ Stage 2 输出：任务分类 ═══
export type TaskType = 'chat' | 'code' | 'document' | 'research';

export interface TaskContext {
  taskType: TaskType;
  sessionId: string; // ToolStrategy 的 sudo 包装 / 权限钩子需要
  userMessage: string;
  modelCtx: ModelContext;
  platform: NodeJS.Platform;
  hasMCPTools: boolean;
  sandboxPath?: string;
  effectiveCwd: string;
}

// ═══ Stage 2 各策略输出 ═══
export interface AssembledPrompt {
  systemPrompt: string; // 注入 appendSystemPromptOverride 的子集
  tokenEstimate: number;
}

export interface AssembledTools {
  /** 全量内置工具（不按任务裁剪，锁定决策 §3.3）+ 包装链，传给 createAgentSession 的 tools */
  codingTools: ToolDefinition[];
}

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// ═══ Stage 3 输入/输出：Session 工厂 ═══
export interface SessionInput {
  sessionId: string;
  modelCtx: ModelContext;
  taskCtx: TaskContext;
  prompt: AssembledPrompt;
  tools: AssembledTools;
  thinkingLevel: PiThinkingLevel;
  skillPaths: string[];
  customTools: ToolDefinition[];
  existingMessages: Message[];
}

export interface SessionOutput {
  piSession: PiAgentSession;
  isReused: boolean;
}

/**
 * Estimate chars-per-token ratio based on content language.
 * CJK characters tokenize at ~1.5 chars/token vs ~4 for English.
 */
export function estimateCharsPerToken(sampleText: string): number {
  if (!sampleText || sampleText.length === 0) return 4;
  const sample = sampleText.substring(0, 500);
  const cjkCount = (sample.match(/[一-鿿぀-ゟ゠-ヿ가-힯]/g) || []).length;
  const cjkRatio = cjkCount / sample.length;
  return 4 - cjkRatio * 2.5; // Range: 1.5 (pure CJK) ~ 4 (pure English)
}
