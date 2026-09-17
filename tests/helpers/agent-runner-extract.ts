/**
 * tests/helpers/agent-runner-extract.ts
 *
 * 结构化源码片段抽取辅助（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.1 L4）。
 *
 * 背景：tests/agent-runner-loop-guard-abort.test.ts 原本用
 * `indexOf` + `slice(setIdx, abortIdx)` + 固定窗口（如 `slice(start, end + 800)`）
 * 这类"行号/位置敏感"的断言方式检查 agent-runner.ts 源码。Phase 1-6 的物理拆分
 * 会移动这些代码，固定偏移窗口极易失效。本 helper 提供基于锚点标记与括号
 * 平衡的结构化抽取，让断言只依赖"代码结构"而不是"字符偏移量"。
 */

/** 去掉单行注释（// ...），保留代码；用于"注释里可以提到某字面量，但代码里不行"类断言。 */
export function stripLineComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** 只保留非空、非纯注释行（用于"两个锚点之间不得夹带其他代码"类断言）。 */
export function nonTrivialLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));
}

/**
 * 从 fromIdx 起向后扫描，返回第一个与 fromIdx 处字符配对的闭合括号位置。
 * 支持 {} () []；跳过字符串/模板字面量/注释中的括号。
 */
export function findMatchingClose(source: string, fromIdx: number): number {
  const open = source[fromIdx];
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const close = pairs[open];
  if (!close) {
    throw new Error(
      `findMatchingClose: expected an opening bracket at index ${fromIdx}, got "${open}"`
    );
  }

  let depth = 0;
  let i = fromIdx;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (; i < source.length; i++) {
    const ch = source[i];
    const prev = i > fromIdx ? source[i - 1] : '';

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === '*' && ch === '/') inBlockComment = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '`' && prev !== '\\') inTemplate = false;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      continue;
    }

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 找到 anchor 首次出现的位置，从其后的第一个 `{` 开始按括号平衡抽取整个块。
 * 适合抽取 `if (...) { ... }` / `function foo(...) { ... }` / `} else if (...) { ... }` 体。
 * 找不到时抛错（让测试以清晰信息失败，而不是拿到 undefined 后报奇怪的断言错）。
 */
export function extractBlockAfter(source: string, anchor: string): string {
  const anchorIdx = source.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(`extractBlockAfter: anchor not found: ${JSON.stringify(anchor)}`);
  }
  const braceIdx = source.indexOf('{', anchorIdx + anchor.length - 1);
  if (braceIdx === -1) {
    throw new Error(`extractBlockAfter: no "{" after anchor: ${JSON.stringify(anchor)}`);
  }
  const endIdx = findMatchingClose(source, braceIdx);
  if (endIdx === -1) {
    throw new Error(`extractBlockAfter: unbalanced braces after anchor: ${JSON.stringify(anchor)}`);
  }
  return source.slice(braceIdx, endIdx + 1);
}

/**
 * 抽取从 startAnchor（含）到 endAnchor（含 endAnchor 自身长度）之间的源码。
 * 用于"分支 A 必须出现在分支 B 之前"这类顺序断言，替代固定 +800 字符窗口。
 */
export function extractBetween(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  if (start === -1) {
    throw new Error(`extractBetween: start anchor not found: ${JSON.stringify(startAnchor)}`);
  }
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (end === -1) {
    throw new Error(`extractBetween: end anchor not found: ${JSON.stringify(endAnchor)}`);
  }
  return source.slice(start, end + endAnchor.length);
}

/**
 * 抽取调用点前导窗口（如 sendMessage({...}) 的参数区），
 * 用于断言"某调用没有被包在 if (!xxx) 门里"这类回归检查。
 * 返回 callAnchor 之前 windowSize 个字符。
 */
export function preambleBefore(source: string, callAnchor: string, windowSize = 400): string {
  const idx = source.indexOf(callAnchor);
  if (idx === -1) {
    throw new Error(`preambleBefore: anchor not found: ${JSON.stringify(callAnchor)}`);
  }
  return source.slice(Math.max(0, idx - windowSize), idx);
}

/**
 * 抽取 callAnchor 之后 windowSize 个字符（含锚点自身）。
 */
export function windowAfter(source: string, callAnchor: string, windowSize = 400): string {
  const idx = source.indexOf(callAnchor);
  if (idx === -1) {
    throw new Error(`windowAfter: anchor not found: ${JSON.stringify(callAnchor)}`);
  }
  return source.slice(idx, idx + windowSize);
}

/**
 * 找到 anchor 前最近一次出现 nearAnchor 的位置，返回两者之间的源码。
 * 用于"某字面量必须出现在最近的某调用之内"这类局部性断言
 * （如 title: 'Stopped: tool-call loop detected' 必须在最近的 sendTraceUpdate 调用里）。
 */
export function extractNearestBefore(
  source: string,
  nearAnchor: string,
  targetAnchor: string
): string {
  const targetIdx = source.indexOf(targetAnchor);
  if (targetIdx === -1) {
    throw new Error(
      `extractNearestBefore: target anchor not found: ${JSON.stringify(targetAnchor)}`
    );
  }
  const nearIdx = source.lastIndexOf(nearAnchor, targetIdx);
  if (nearIdx === -1) {
    throw new Error(
      `extractNearestBefore: near anchor not found before target: ${JSON.stringify(nearAnchor)}`
    );
  }
  return source.slice(nearIdx, targetIdx);
}
