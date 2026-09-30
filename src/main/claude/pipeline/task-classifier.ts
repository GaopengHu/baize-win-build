/**
 * @module main/claude/pipeline/task-classifier
 *
 * Stage 2 任务分类器（AGENT-RUNNER-REFACTOR-PLAN.md §3.1 / Phase 4）。
 *
 * 纯正则、零 API 调用，中英双语关键词匹配。
 * 优先级：document > code > research > chat（默认兜底）。
 *
 * 为什么用正则而非 LLM 分类：
 * - 分类结果只影响 prompt 子集与 thinking level（工具集恒定全量，§3.3 锁定），
 *   误分类的代价很低且下一条消息即恢复；
 * - 避免分类步骤引入额外的 API 调用延迟。
 *
 * 契约：classifyTask 绝不抛错，任何输入都返回合法类别。
 */
import type { TaskType } from './context-types';

/** 文档生成意图：动词 + 文档类名词（中英双语）。 */
const DOCUMENT_PATTERNS: RegExp[] = [
  /(生成|制作|创建|编写|撰写|导出|输出|整理成?|编制|做|写)[^。，,;!！?？\n]{0,16}(文档|报告|总结|周报|日报|月报|年报|方案|计划书?|简历|合同|说明书|手册|海报|幻灯片|演示文稿|表格|发票)/,
  /(做|生成|创建|制作|写)(个|一份|一个|套)?\s*(ppt|pptx|word|docx|excel|xlsx|pdf|幻灯片|演示文稿)/i,
  /\b(generate|create|make|write|export|build|draft|prepare)\b[^.!?\n]{0,32}\b(document|report|summary|slides?|presentation|pptx?|docx?|xlsx?|excel|word|pdf|resume|cv|invoice|poster|handbook|manual|brochure)\b/i,
  /\bpowerpoint\b/i,
];

/** 编码意图：源码文件路径、编程动词/名词（中英双语）。 */
const CODE_PATTERNS: RegExp[] = [
  /[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|c|cpp|cc|h|hpp|sh|bat|ps1|css|scss|html|vue|svelte|sql|toml)\b/i,
  /(修复|修改|改一下|改掉|重构|优化|实现|编写|调试|排查|跑不通|跑一下|运行|编译|构建|打包|部署|报错|崩溃|闪退|单测|测试用例|写代码|改代码|加个?功能|开发)/,
  /(写|编写|实现|封装)(一个|个|一份)?(函数|方法|类|接口|组件|脚本|程序|模块|插件)/,
  /\b(fix|bug|refactor|debug|implement|compile|build error|deploy|lint|typecheck|unit tests?|stack ?trace|merge conflict|pull request|regression)\b/i,
  /\b(function|component|api endpoint|codebase|snippet|class method)\b/i,
];

/** 研究/搜索意图：查询、调研、时效性信息（中英双语）。 */
const RESEARCH_PATTERNS: RegExp[] = [
  /(搜索|搜一下|搜几个|搜点|查一下|查询|查查|查找|调研|检索|了解一下?|最新消息|最新|新闻|资讯|行情|天气|股价|热点|浏览|上网)/,
  /\b(search(ing)?|look up|research|find out|find recent|latest|news|trending|browse|google|web search)\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * 根据用户消息内容快速判断任务类型。绝不抛错。
 *
 * 优先级 document > code > research > chat：
 * 文档生成意图最明确（用户点名要产物），编码次之，
 * 研究/搜索再次，其余全部落入纯对话兜底。
 */
export function classifyTask(userMessage: string): TaskType {
  try {
    const msg = typeof userMessage === 'string' ? userMessage.trim() : '';
    if (!msg) return 'chat';

    if (matchesAny(msg, DOCUMENT_PATTERNS)) return 'document';
    if (matchesAny(msg, CODE_PATTERNS)) return 'code';
    if (matchesAny(msg, RESEARCH_PATTERNS)) return 'research';
    return 'chat';
  } catch {
    return 'chat';
  }
}
