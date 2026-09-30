import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const decidePermissionMock = vi.fn();
const rememberAlwaysAllowMock = vi.fn();
vi.mock('../../../src/main/config/permission-rules-store', () => ({
  decidePermission: (...args: unknown[]) => decidePermissionMock(...args),
  rememberAlwaysAllow: (...args: unknown[]) => rememberAlwaysAllowMock(...args),
}));

const classifyPermissionMock = vi.fn();
const resolvePermissionGateMock = vi.fn();
vi.mock('../../../src/main/utils/permission-classifier', () => ({
  classifyPermission: (...args: unknown[]) => classifyPermissionMock(...args),
  resolvePermissionGate: (...args: unknown[]) => resolvePermissionGateMock(...args),
}));

import { installPermissionHook } from '../../../src/main/claude/tools/permission-hook';

interface FakeAgent {
  setBeforeToolCall: ReturnType<typeof vi.fn>;
  _beforeToolCall?: (ctx: unknown, signal?: AbortSignal) => Promise<unknown>;
}

function createFakeSession(): { piSession: unknown; agent: FakeAgent } {
  const agent: FakeAgent = { setBeforeToolCall: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { piSession: { agent } as any, agent };
}

function captureHook(agent: FakeAgent): (ctx: unknown, signal?: AbortSignal) => Promise<unknown> {
  expect(agent.setBeforeToolCall).toHaveBeenCalledTimes(1);
  return agent.setBeforeToolCall.mock.calls[0][0];
}

const baseCtx = { toolCall: { id: 'call-1', name: 'bash' }, args: { command: 'ls' } };

describe('installPermissionHook (Phase 3, tools/permission-hook.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    classifyPermissionMock.mockReturnValue({ kind: 'normal', reason: '' });
    decidePermissionMock.mockReturnValue('allow');
    resolvePermissionGateMock.mockReturnValue('allow');
  });

  const deps = (overrides?: Partial<Parameters<typeof installPermissionHook>[3]>) => ({
    requestPermission: vi.fn(async () => 'allow' as const),
    getToolDisplayName: (name: string) => name,
    ...overrides,
  });

  it('skips installation without a requestPermission callback', () => {
    const { piSession, agent } = createFakeSession();
    installPermissionHook(
      piSession as never,
      'session-1',
      null,
      deps({ requestPermission: undefined })
    );
    expect(agent.setBeforeToolCall).not.toHaveBeenCalled();
  });

  it('skips installation when agent.setBeforeToolCall is unavailable', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const piSession = { agent: {} } as any;
    expect(() => installPermissionHook(piSession, 'session-1', null, deps())).not.toThrow();
  });

  it('installs the hook and blocks denied tools with the display name', async () => {
    const { piSession, agent } = createFakeSession();
    resolvePermissionGateMock.mockReturnValue('deny');
    installPermissionHook(piSession as never, 'session-1', null, deps());
    const hook = captureHook(agent);

    const result = await hook(baseCtx);

    expect(result).toEqual({
      block: true,
      reason: "Tool 'bash' is denied by your permission rules.",
    });
  });

  it('asks the user on gate=ask and blocks on deny', async () => {
    const { piSession, agent } = createFakeSession();
    resolvePermissionGateMock.mockReturnValue('ask');
    const requestPermission = vi.fn(async () => 'deny' as const);
    installPermissionHook(piSession as never, 'session-1', null, deps({ requestPermission }));
    const hook = captureHook(agent);

    const result = await hook(baseCtx);

    expect(requestPermission).toHaveBeenCalledTimes(1);
    // toolUseId 基于 toolCall.id 派生
    expect(requestPermission.mock.calls[0][1]).toMatch(/^call-1-perm-/);
    expect(result).toEqual({ block: true, reason: "User denied permission for 'bash'." });
    expect(rememberAlwaysAllowMock).not.toHaveBeenCalled();
  });

  it('remembers allow_always with the canonical tool name and delegates to the SDK hook', async () => {
    const { piSession, agent } = createFakeSession();
    resolvePermissionGateMock.mockReturnValue('ask');
    const sdkResult = { ok: true };
    agent._beforeToolCall = vi.fn(async () => sdkResult);
    const requestPermission = vi.fn(async () => 'allow_always' as const);
    const getToolDisplayName = vi.fn(() => 'chrome_screenshot');
    installPermissionHook(
      piSession as never,
      'session-1',
      null,
      deps({ requestPermission, getToolDisplayName })
    );
    const hook = captureHook(agent);

    const ctx = {
      toolCall: { id: 'call-2', name: 'mcp__chrome__chrome_screenshot__ab12' },
      args: {},
    };
    const result = await hook(ctx);

    // 弹窗展示用 displayName，规则记忆用 canonical toolName
    expect(requestPermission.mock.calls[0][2]).toBe('chrome_screenshot');
    expect(rememberAlwaysAllowMock).toHaveBeenCalledWith(
      'session-1',
      'mcp__chrome__chrome_screenshot__ab12'
    );
    expect(result).toBe(sdkResult);
    expect(agent._beforeToolCall).toHaveBeenCalledWith(ctx, undefined);
  });

  it('fails closed when the permission request throws', async () => {
    const { piSession, agent } = createFakeSession();
    resolvePermissionGateMock.mockReturnValue('ask');
    const requestPermission = vi.fn(async () => {
      throw new Error('ipc down');
    });
    installPermissionHook(piSession as never, 'session-1', null, deps({ requestPermission }));
    const hook = captureHook(agent);

    const result = await hook(baseCtx);

    expect(result).toEqual({
      block: true,
      reason: "Permission request failed for 'bash'; tool not executed.",
    });
  });

  it('passes sessionAllowAll through to the gate resolution', async () => {
    const { piSession, agent } = createFakeSession();
    const sessionAllowAll = vi.fn(() => true);
    installPermissionHook(piSession as never, 'session-1', null, deps({ sessionAllowAll }));
    const hook = captureHook(agent);

    await hook(baseCtx);

    expect(sessionAllowAll).toHaveBeenCalledWith('session-1');
    expect(resolvePermissionGateMock).toHaveBeenCalledWith('normal', 'allow', true);
  });

  it('returns undefined when allowed and no SDK hook was chained', async () => {
    const { piSession, agent } = createFakeSession();
    installPermissionHook(piSession as never, 'session-1', null, deps());
    const hook = captureHook(agent);

    await expect(hook(baseCtx)).resolves.toBeUndefined();
  });

  it('allows orchestration tools (dispatch_agent) without approval or rule lookup', async () => {
    const { piSession, agent } = createFakeSession();
    const sdkResult = { ok: true };
    agent._beforeToolCall = vi.fn(async () => sdkResult);
    const requestPermission = vi.fn(async () => 'allow' as const);
    decidePermissionMock.mockReturnValue('ask');
    resolvePermissionGateMock.mockReturnValue('ask');
    installPermissionHook(piSession as never, 'session-1', null, deps({ requestPermission }));
    const hook = captureHook(agent);

    const ctx = {
      toolCall: { id: 'call-d', name: 'dispatch_agent' },
      args: { description: 'd', prompt: 'p', subagent_type: 'research' },
    };
    const result = await hook(ctx);

    expect(requestPermission).not.toHaveBeenCalled();
    expect(decidePermissionMock).not.toHaveBeenCalled();
    expect(classifyPermissionMock).not.toHaveBeenCalled();
    expect(result).toBe(sdkResult);
  });
});
