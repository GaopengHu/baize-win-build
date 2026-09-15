import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import { configStore } from '../config/config-store';
import { logWarn } from '../utils/logger';
import type { MemoryService } from './memory-service';

export class MemoryExtension implements AgentRuntimeExtension {
  readonly name = 'memory';

  constructor(private readonly memoryService: MemoryService) {}

  async beforeSessionRun({
    session,
    prompt,
  }: Parameters<
    NonNullable<AgentRuntimeExtension['beforeSessionRun']>
  >[0]): Promise<BeforeSessionRunResult | void> {
    if (!this.memoryService.isEnabled() || !session.memoryEnabled) {
      return;
    }

    const runtime = configStore.get('memoryRuntime');
    const retrievalMode = runtime?.retrievalMode ?? 'background';

    if (retrievalMode === 'blocking') {
      return {
        promptPrefix: await this.memoryService.buildPromptPrefix(session, prompt),
      };
    }

    // Background mode: keep the first-token path free of LLM-based experience
    // retrieval. Core memory (small, in-memory) is injected synchronously; the
    // experience block is retrieved in parallel and injected mid-turn via
    // steering (see deferred-memory-injector in agent-runner).
    const corePrefix = this.memoryService.buildCorePromptPrefix();
    const deferredExperience = this.memoryService
      .acquireExperience(session.id, prompt)
      .catch((error) => {
        logWarn('[MemoryExtension] background experience retrieval failed:', error);
        return '';
      });

    return {
      promptPrefix: corePrefix || undefined,
      deferredExperience,
    };
  }

  async afterSessionRun({
    session,
    prompt,
    messages,
  }: Parameters<NonNullable<AgentRuntimeExtension['afterSessionRun']>>[0]): Promise<void> {
    if (!this.memoryService.isEnabled() || !session.memoryEnabled) {
      return;
    }
    await this.memoryService.enqueueIngestion({
      session,
      prompt,
      messages,
    });
  }

  async onSessionDeleted({
    sessionId,
  }: Parameters<NonNullable<AgentRuntimeExtension['onSessionDeleted']>>[0]): Promise<void> {
    await this.memoryService.deleteSession(sessionId);
  }
}
