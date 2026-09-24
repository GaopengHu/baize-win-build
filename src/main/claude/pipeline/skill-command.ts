/**
 * @module main/claude/pipeline/skill-command
 *
 * `/skill:<name> [args]` 显式展开（斜杠技能选择器的主进程侧）。
 *
 * 背景：pi SDK 的 AgentSession.prompt() 内部会调用私有方法 _expandSkillCommand
 * （agent-session.js:659 → :779-805，SDK 0.60）展开以 "/skill:" 开头的文本。
 * 但 NowLink 在调用 prompt() 之前会给用户文本拼接冷启动 <conversation_history>
 * preamble（cold-start-history.ts）和/或 extension promptPrefix——拼接后文本
 * 不再以 "/skill:" 开头，SDK 的 startsWith 检查失败，展开被静默跳过。
 *
 * 因此本模块用**纯公开 API**（type Skill / stripFrontmatter，均为包根导出）
 * 在拼接之前复刻同一展开逻辑。展开成功后文本以 "<skill" 开头，SDK 自身的
 * 展开天然 no-op——不存在双重展开。
 *
 * ⚠️ 版本一致性：输出格式逐字对齐 pi-coding-agent 0.60 的
 * agent-session.js:779-805（`<skill name=... location=...>` 包裹 +
 * "References are relative to ..." 行 + args 追加）。SDK 升级若改动该格式，
 * skill-command.test.ts 的格式一致性断言会失败，届时需同步修订。
 */
import { readFileSync } from 'node:fs';
import { stripFrontmatter, type Skill } from '@mariozechner/pi-coding-agent';
import { logWarn } from '../../utils/logger';

const SKILL_COMMAND_PREFIX = '/skill:';

/**
 * 展开以 "/skill:<name>" 开头的用户文本。
 *
 * 行为与 SDK AgentSession._expandSkillCommand 逐字对齐（agent-session.js:779-805）：
 * - 非 "/skill:" 开头 → 原样返回；
 * - 名称/参数以**第一个空格**分界（换行不是分隔符——照抄 SDK，勿"改进"）；
 * - 精确名称匹配，首个命中即取；未知技能原样透传（按字面文本发送）；
 * - SKILL.md 读取后 stripFrontmatter + trim，包裹为 <skill> 块；args 非空追加；
 * - 读取/解析异常 → logWarn + 原样返回，绝不抛出。
 *
 * @param text 原始用户 prompt（未经任何 preamble/prefix 拼接）
 * @param skills SDK 权威技能列表——调用方应传
 *   `piSession.resourceLoader.getSkills().skills`（与 _expandSkillCommand 内部同源）
 */
export function expandSkillCommand(text: string, skills: readonly Skill[]): string {
  if (!text.startsWith(SKILL_COMMAND_PREFIX)) {
    return text;
  }

  const spaceIndex = text.indexOf(' ');
  const skillName =
    spaceIndex === -1
      ? text.slice(SKILL_COMMAND_PREFIX.length)
      : text.slice(SKILL_COMMAND_PREFIX.length, spaceIndex);
  const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();

  const skill = skills.find((s) => s.name === skillName);
  if (!skill) {
    // Unknown skill — pass through as literal text (same as SDK).
    return text;
  }

  try {
    const content = readFileSync(skill.filePath, 'utf-8');
    const body = stripFrontmatter(content).trim();
    // 格式串逐字抄自 SDK agent-session.js:790 —— 勿改动（测试有一致性断言）。
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return args ? `${skillBlock}\n\n${args}` : skillBlock;
  } catch (err) {
    logWarn('[skill-command] expansion failed for', skillName, err);
    return text;
  }
}
