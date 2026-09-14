import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { TSchema } from '@sinclair/typebox';
import type { Message, Session } from '../../renderer/types';

export type AgentRuntimeCustomTool = ToolDefinition<TSchema, unknown>;

export interface BeforeSessionRunContext {
  session: Session;
  prompt: string;
  existingMessages: Message[];
  isColdStart: boolean;
}

export interface BeforeSessionRunResult {
  promptPrefix?: string;
  customTools?: AgentRuntimeCustomTool[];
  /**
   * Context that is retrieved asynchronously (e.g. experience memory) and can
   * be injected mid-turn via steering instead of blocking the first token.
   * Resolves to '' when there is nothing to inject. Never rejects.
   */
  deferredExperience?: Promise<string>;
}

export interface AfterSessionRunContext {
  session: Session;
  prompt: string;
  messages: Message[];
}

export interface SessionDeletedContext {
  sessionId: string;
  session?: Session | null;
}

export interface AgentRuntimeExtension {
  name: string;
  beforeSessionRun?(context: BeforeSessionRunContext): Promise<BeforeSessionRunResult | void>;
  afterSessionRun?(context: AfterSessionRunContext): Promise<void>;
  onSessionDeleted?(context: SessionDeletedContext): Promise<void>;
}
