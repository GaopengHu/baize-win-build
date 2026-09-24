/**
 * "/" 斜杠技能选择器的纯逻辑（ChatView 输入框自动补全）。
 *
 * 三个纯函数供 useSlashSkillMenu hook 与组件消费，逻辑级 vitest 覆盖
 * （src/tests/renderer/slash-skill-menu.test.ts）：
 * - parseSlashQuery：从输入文本判定菜单是否打开、当前查询串；
 * - filterSkills：大小写不敏感过滤 + name 前缀 > name 子串 > description 子串
 *   优先级（稳定排序）；
 * - buildSkillCommand：选中后插入 `/skill:<name> `（尾随空格待输 args）。
 *
 * 注意：这里的 `Skill` 是 **renderer** 类型（types/index.ts），
 * 严禁与 SDK（@mariozechner/pi-coding-agent）的同名 Skill 类型交叉 import。
 */
import type { Skill } from '../types';

/**
 * 判定斜杠菜单是否应处于打开状态。
 *
 * active 条件：文本以 "/" 开头，且首个空白分隔 token 仍在输入中
 * （出现空格/换行即关闭——其后内容是技能的 args，不再参与补全）。
 *
 * @returns active=true 时 query 为去掉前导 "/" 的首 token（可能为空串）
 */
export function parseSlashQuery(prompt: string): { active: boolean; query: string } {
  if (!prompt.startsWith('/')) {
    return { active: false, query: '' };
  }
  // 首个空白（空格/换行/制表符）出现即代表命令 token 输入完毕
  const whitespaceIndex = prompt.search(/\s/);
  const token = whitespaceIndex === -1 ? prompt.slice(1) : prompt.slice(1, whitespaceIndex);
  if (whitespaceIndex !== -1) {
    return { active: false, query: token };
  }
  return { active: true, query: token };
}

/**
 * 按查询串过滤技能列表。
 *
 * 优先级（稳定排序，同级保持原顺序）：
 * 1. name 以 query 开头（大小写不敏感）
 * 2. name 包含 query
 * 3. description 包含 query
 *
 * 空 query → 返回前 limit 项（全量展示的截断）。
 */
export function filterSkills(skills: Skill[], query: string, limit = 8): Skill[] {
  const q = query.toLowerCase();
  if (!q) {
    return skills.slice(0, limit);
  }
  const namePrefix: Skill[] = [];
  const nameSubstr: Skill[] = [];
  const descSubstr: Skill[] = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    if (name.startsWith(q)) {
      namePrefix.push(skill);
    } else if (name.includes(q)) {
      nameSubstr.push(skill);
    } else if (skill.description?.toLowerCase().includes(q)) {
      descSubstr.push(skill);
    }
  }
  return [...namePrefix, ...nameSubstr, ...descSubstr].slice(0, limit);
}

/** 选中技能后插入的命令文本；尾随空格供用户继续输入 args。 */
export function buildSkillCommand(name: string): string {
  return `/skill:${name} `;
}
