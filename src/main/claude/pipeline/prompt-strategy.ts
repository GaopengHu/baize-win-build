/**
 * @module main/claude/pipeline/prompt-strategy
 *
 * Stage 2 Prompt 策略（AGENT-RUNNER-REFACTOR-PLAN.md §3.2 / Phase 4）。
 *
 * 从 agent-runner.ts 的 coworkAppendPrompt 内联数组提取：所有 section 文本
 * 原样搬移（不改措辞），只是从「全量恒定注入」改为「按 TaskContext 条件注入」：
 *
 * | 任务类型 | 注入的 section |
 * |---------|---------------|
 * | chat     | baseRules + workspaceInfo + platformInfo(win32) + toolBehavior |
 * | research | 同 chat（citation 由 hasMCPTools 决定） |
 * | code     | + codeQualityRules |
 * | document | + documentGenerationRules |
 *
 * 工具集恒定全量（§3.3 锁定），因此 toolBehavior（含参数名教学）注入
 * **所有**任务类型——被分类为 chat 的消息也可能需要读写文件，缺教学会
 * 导致参数名错误往返。
 *
 * 运行时生效机制（mutable appendSystemPromptOverride 闭包 + reload()）
 * 属 Phase 5 session-factory，本模块只负责产出 AssembledPrompt。
 */
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { getDefaultShell } from '../../utils/shell-resolver';
import { detectCommandTools, formatDetectedTools } from '../../utils/detect-command-tools';
import { getBundledNodePaths, resolveBundledPythonBinDir } from './path-utils';
import { estimateCharsPerToken } from './context-types';
import type { AssembledPrompt, TaskContext } from './context-types';

/**
 * Virtual workspace path shown to the model (hides real sandbox path).
 * agent-runner.ts 的输出路径脱敏（sanitizeOutputPaths）共用此常量。
 */
export const VIRTUAL_WORKSPACE_PATH = '/workspace';

/**
 * Generate bundled executable path hints for production mode system prompt.
 * In dev mode returns empty string (user PATH already works).
 * This is a defense-in-depth layer — even if PATH enrichment works, explicit
 * paths help the model avoid ambiguity when Skills reference bare commands.
 * （Phase 4 从 agent-runner 私有方法 getBundledPathHints 原样搬移）
 */
export function getBundledPathHints(): string {
  if (!app.isPackaged) return '';

  const hints: string[] = [];

  const nodePaths = getBundledNodePaths();
  if (nodePaths) {
    hints.push(`- node: ${nodePaths.node}`);
    hints.push(`- npx: ${nodePaths.npx}`);
  }

  const pythonBinDir = resolveBundledPythonBinDir();
  if (pythonBinDir) {
    const pythonExe = process.platform === 'win32' ? 'python.exe' : 'python3';
    const pipExe = process.platform === 'win32' ? 'pip.exe' : 'pip3';
    hints.push(`- python3: ${path.join(pythonBinDir, pythonExe)}`);
    if (fs.existsSync(path.join(pythonBinDir, pipExe))) {
      hints.push(`- pip3: ${path.join(pythonBinDir, pipExe)}`);
    }
  }

  if (hints.length === 0) return '';

  return `<bundled_executables>
This application bundles its own executables. When executing commands, prefer these absolute paths:
${hints.join('\n')}
</bundled_executables>`;
}

export class PromptStrategy {
  assemble(ctx: TaskContext): AssembledPrompt {
    const sections: string[] = [this.baseRules(), this.workspaceInfo(ctx)];

    // 平台信息：工具集恒定全量（§3.3），任何任务都可能用到工具，win32 一律注入
    if (ctx.platform === 'win32') {
      sections.push(this.platformInfo());
    }

    // 工具行为（含参数命名教学）：所有任务类型都注入（§3.2）
    sections.push(this.toolBehavior());

    if (ctx.taskType === 'code') {
      sections.push(this.codeQualityRules());
    }

    if (ctx.taskType === 'document') {
      sections.push(this.documentGenerationRules());
    }

    // 引用要求：仅在实际桥接了 MCP 工具时注入（此前为无条件注入）
    if (ctx.hasMCPTools) {
      sections.push(this.citationRequirements());
    }

    const bundledPaths = getBundledPathHints();
    if (bundledPaths) {
      sections.push(bundledPaths);
    }

    const systemPrompt = sections
      .filter((section) => Boolean(section && section.trim()))
      .join('\n\n');

    // 内容感知的 token 量级估算（CJK ~1.5 chars/token，英文 ~4）
    const tokenEstimate = Math.ceil(systemPrompt.length / estimateCharsPerToken(systemPrompt));
    return { systemPrompt, tokenEstimate };
  }

  private baseRules(): string {
    return `你是今点通智能助手，请用中文回复用户。
CRITICAL BEHAVIORAL RULES:
1. CHAT FIRST: By default, respond to the user in plain text within the conversation. Do NOT create, write, or edit files unless the user explicitly asks you to (e.g., "create a file", "write this to...", "edit the code", "save as...", mentions a specific file path, or describes code changes they want applied). For questions, summaries, explanations, analysis, and general conversation — always reply directly in chat text.
2. LANGUAGE: Always respond in the same language as the user's input. If the user asks in Chinese, reply in Chinese. If the user asks in English, reply in English.
3. When a request is actionable, proceed immediately with reasonable assumptions. If you need clarification, ask briefly in plain text.
4. For relative time windows like "within two days" in browsing or research tasks, assume the most recent two relevant publication days unless the user explicitly defines another date range.
5. For bracketed placeholders like [Agent], [Topic], etc., treat the word inside brackets as the literal search keyword unless the user says otherwise.
6. When given a task, START DOING IT. Do not restate the task, do not list what you will do, do not ask for confirmation. Just execute.`;
  }

  private workspaceInfo(ctx: TaskContext): string {
    if (ctx.sandboxPath) {
      return `<workspace_info>
Your current workspace is located at: ${VIRTUAL_WORKSPACE_PATH}
This is an isolated sandbox environment. Use ${VIRTUAL_WORKSPACE_PATH} as the root path for file operations.
</workspace_info>`;
    }
    return ctx.workingDir
      ? `<workspace_info>Your current workspace is: ${ctx.workingDir}</workspace_info>`
      : '';
  }

  private platformInfo(): string {
    const detected = detectCommandTools();
    const selectedShell = getDefaultShell();
    const shellName = selectedShell.toLowerCase();
    const isPowerShell = shellName.includes('powershell') || shellName === 'pwsh.exe';
    const isCmd = shellName === 'cmd.exe';
    return `<platform_info>
You are running on Windows. Commands will be executed using: ${selectedShell}
${isPowerShell ? '- PowerShell has built-in aliases for `ls`, `cat`, `cp`, `mv`, `rm`, `pwd`, `clear`' : ''}
${isPowerShell ? '- Use `;` (semicolon) to chain commands, NOT `&&` (PowerShell 5.x does not support `&&`)' : ''}
${isCmd ? '- Use `&&` to chain commands (cmd.exe syntax)' : ''}
${isPowerShell ? '- Redirect stderr with `2>` (PowerShell syntax)' : ''}
${isCmd ? '- Redirect stderr with `2>` (cmd.exe syntax)' : ''}
- Use \`dir\` instead of \`ls\`
- Use \`type\` instead of \`cat\`
- Use \`findstr\` instead of \`grep\`
- Use \`del\` instead of \`rm\`
- Use \`copy\` instead of \`cp\`
- Use \`move\` instead of \`mv\`
- Use \`cls\` instead of \`clear\`
- File paths use backslashes (but forward slashes also work in most cases)

${formatDetectedTools(detected)}
</platform_info>`;
  }

  private toolBehavior(): string {
    return `<tool_behavior>
Tool routing:
- If user explicitly asks to use Chrome/browser/web navigation, prioritize Chrome MCP tools (mcp__Chrome__*) over generic WebSearch/WebFetch.
- Use WebSearch/WebFetch only when Chrome MCP is unavailable or the user explicitly asks for generic web search.

Tool parameter naming (CRITICAL - incorrect parameter names will cause validation errors):
- read tool: use \`path\` (NOT \`file_path\` or \`filePath\`)
- write tool: use \`path\` and \`content\` (NOT \`file_path\` or \`filePath\`)
- edit tool: use \`path\`, \`oldText\`, and \`newText\` (NOT \`file_path\`, \`old_string\`, or \`new_string\`)
- bash tool: use \`command\` and optionally \`timeout\`
</tool_behavior>`;
  }

  private citationRequirements(): string {
    return `<citation_requirements>
If your answer uses linkable content from MCP tools, include a "Sources:" section and otherwise use standard Markdown links: [Title](https://claude.ai/chat/URL).
</citation_requirements>`;
  }

  private codeQualityRules(): string {
    return `<code_quality_rules>
When writing or modifying code:
1. DEPENDENCY CHECK: Before using any library, verify it exists in package.json (or equivalent manifest). If not available, install it first or use an existing alternative.
2. READ BEFORE WRITE: Always read existing files before modifying them. Never assume file contents or structure.
3. ERROR HANDLING: Include proper error handling (try-catch, null checks, boundary validation). Never silently swallow errors.
4. SECURITY: Validate user inputs. Never hardcode secrets or API keys. Use parameterized queries for databases.
5. CODE STYLE: Match the existing project style — indentation, naming conventions, import patterns, and comment style.
6. VERIFICATION: After making changes, run available verification commands (lint, typecheck, test) if defined in package.json scripts or equivalent.
7. MINIMAL CHANGES: Make the smallest change that achieves the goal. Do not refactor unrelated code unless asked.
8. EXPLAIN BRIEFLY: After completing changes, summarize what was done and why in 2-3 sentences.
</code_quality_rules>`;
  }

  private documentGenerationRules(): string {
    return `<document_generation_rules>
When generating documents (Word/DOCX, PowerPoint/PPTX, Excel/XLSX, PDF, etc.):

1. READ SKILL DOCS FIRST: Read the relevant SKILL.md to understand the API and best practices before writing code. Do not skip this step — understanding the API prevents errors.

2. ONE COMPLETE SCRIPT: Plan the full document content, then write ONE script that generates everything in a single execution.

3. EXECUTE AND FIX: Run the script. If it fails, read the error carefully, fix the issue, and re-run. Maximum 3 retry attempts. Do not rewrite from scratch — fix the specific error.

4. BUDGET: Aim for 5-10 tool calls total for a complete document. Complex documents may require more.

5. CONTENT FIRST: Focus on delivering correct, complete content the user asked for. Use clean, simple formatting unless the user explicitly requests elaborate styling.
</document_generation_rules>`;
  }
}
