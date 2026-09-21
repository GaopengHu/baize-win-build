/**
 * @module main/claude/tools/bash-tool-wrappers
 *
 * bash 工具的包装链：默认超时注入 + sudo 密码交互。
 * 从 agent-runner.ts 的私有方法提取为自由函数（AGENT-RUNNER-REFACTOR-PLAN.md §3.8 / Phase 1）。
 *
 * 包装顺序（tool-strategy 组装时）：wrapBashToolWithDefaultTimeout → wrapBashToolForSudo。
 */
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { spawn } from 'child_process';
import { log, logError } from '../../utils/logger';

/** 用户级 sudo 密码请求回调（与 AgentRunnerOptions.requestSudoPassword 同签名）。 */
export type RequestSudoPasswordFn = (
  sessionId: string,
  toolUseId: string,
  command: string
) => Promise<string | null>;

/**
 * Check if a command contains sudo
 */
export function isSudoCommand(command: string): boolean {
  return /\bsudo\b/.test(command);
}

/**
 * Wrap the bash tool in the coding tools array to intercept sudo commands.
 * When a sudo command is detected, prompts the user for a password,
 * then rewrites the command to pipe the password into sudo -S.
 */
export function wrapBashToolForSudo(
  tools: ToolDefinition[],
  sessionId: string,
  effectiveCwd: string,
  requestSudoPassword?: RequestSudoPasswordFn
): ToolDefinition[] {
  if (!requestSudoPassword) return tools;

  return tools.map((tool) => {
    if (tool.name !== 'bash') return tool;

    const originalExecute = tool.execute;
    return {
      ...tool,
      execute: async (
        toolCallId: string,
        params: { command: string; timeout?: number },
        signal: AbortSignal | undefined,
        onUpdate: ((update: unknown) => void) | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx: any
      ) => {
        const command = params.command;

        if (isSudoCommand(command)) {
          log('[ClaudeAgentRunner] Sudo command detected, requesting password');
          const password = await requestSudoPassword(sessionId, toolCallId, command);

          if (!password) {
            log('[ClaudeAgentRunner] Sudo password cancelled by user');
            return {
              content: [
                { type: 'text' as const, text: 'Command cancelled: user denied sudo password.' },
              ],
              details: undefined as unknown,
            };
          }

          // Add -S flag to sudo invocations that don't already have it
          const rewrittenCommand = command.replace(/\bsudo\b(?!\s+-S)/g, 'sudo -S');

          // Pass password via stdin pipe so it never appears in process args
          // or environment variables. Uses async spawn with stdio: 'pipe'.
          log(
            '[ClaudeAgentRunner] Executing sudo command with password injection (via stdin pipe)'
          );
          try {
            const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
            const shellArgs =
              process.platform === 'win32' ? ['/c', rewrittenCommand] : ['-c', rewrittenCommand];
            const timeoutMs = (params.timeout ?? 120) * 1000;
            const output = await new Promise<string>((resolve, reject) => {
              const child = spawn(shell, shellArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: effectiveCwd,
              });
              let stdout = '';
              let stderr = '';
              const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`Sudo command timed out after ${timeoutMs}ms`));
              }, timeoutMs);
              child.stdout.on('data', (chunk: Buffer) => {
                stdout += chunk.toString();
              });
              child.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString();
              });
              child.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
              });
              child.on('close', () => {
                clearTimeout(timer);
                resolve(stdout + stderr);
              });
              child.stdin.write(password + '\n');
              child.stdin.end();
            });
            return {
              content: [{ type: 'text' as const, text: output || '(no output)' }],
              details: undefined as unknown,
            };
          } catch (sudoErr) {
            logError('[ClaudeAgentRunner] Sudo command failed:', sudoErr);
            throw sudoErr instanceof Error ? sudoErr : new Error(String(sudoErr));
          }
        }

        return originalExecute(toolCallId, params, signal, onUpdate, ctx);
      },
    } as ToolDefinition;
  });
}

/**
 * Wrap the bash tool to inject a default timeout when the model omits one.
 * The agent SDK's bash tool has no default timeout, which means
 * commands can run indefinitely if the model doesn't specify a timeout.
 *
 * 长任务放行：ASR 转写 / 模型下载 / pip 安装首次跑要几分钟到几十分钟。
 * 这些命令若只给 120 秒必被杀，还会拖出整轮 5 分钟无活动超时。
 * 用命令特征识别后直接给 1 小时，短命令仍保持 120 秒防挂死。
 */
export function wrapBashToolWithDefaultTimeout(tools: ToolDefinition[]): ToolDefinition[] {
  const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
  const LONG_TASK_TIMEOUT_SECONDS = 3600;
  // 命中任一即视为长任务：asr 转写/模型预下载、pip 安装、npm 安装、
  // electron 打包、ffmpeg 音视频处理。
  const LONG_TASK_PATTERNS = [
    /transcribe\.py/i,
    /download_model\.py/i,
    /download-win-better-sqlite3/i,
    /bundle-mcp/i,
    /pre-build-check/i,
    /pip(3)?\s+install/i,
    /npm\s+(install|ci|run\s+build)/i,
    /electron-builder/i,
    /ffmpeg/i,
  ];

  return tools.map((tool) => {
    if (tool.name !== 'bash') return tool;

    const originalExecute = tool.execute;
    return {
      ...tool,
      execute: async (
        toolCallId: string,
        params: { command: string; timeout?: number },
        signal: AbortSignal | undefined,
        onUpdate: ((update: unknown) => void) | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx: any
      ) => {
        if (params.timeout != null) {
          return originalExecute(toolCallId, params, signal, onUpdate, ctx);
        }
        const isLongTask = LONG_TASK_PATTERNS.some((re) => re.test(params.command || ''));
        const timeout = isLongTask ? LONG_TASK_TIMEOUT_SECONDS : DEFAULT_BASH_TIMEOUT_SECONDS;
        if (isLongTask) {
          log(
            `[ClaudeAgentRunner] Long-running task detected, timeout extended to ${timeout}s:`,
            (params.command || '').slice(0, 120)
          );
        }
        return originalExecute(toolCallId, { ...params, timeout }, signal, onUpdate, ctx);
      },
    } as ToolDefinition;
  });
}
