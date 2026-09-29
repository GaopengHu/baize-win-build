/**
 * @module main/claude/subagent/search-endpoint
 *
 * research 子 agent 的 `web_search` 后端：endpoint 可配置的多引擎检索。
 *
 * 默认 fail-closed：未配置 / 非法值 / 内网模型地址一律 engine='none'，
 * 用户需在设置 → 通用 → 子 agent 联网检索中显式开启。
 *
 * 引擎选择（默认禁用 fail-closed；用户在设置 → 通用 → 子 agent 联网检索中显式开启）：
 * - `bing-cn`：cn.bing.com/search 结果页爬取，国内可达 + 免费 + 免 key。
 *   非官方接口：页面改版需维护解析器，高频访问可能触发风控。
 * - `sogou`：备用爬取，实测 7s 偏慢，逼近超时上限。
 * - `chrome-mcp`：不注册 web_search，由 Chrome MCP 浏览工具充当联网入口
 *   （本文件不实现，由 profile 工具集层处理）。
 * - `bing-api` / `serper`：付费商业 API，key 由企业部署在 config 文件预置，
 *   不要求终端用户自行申请。
 * - `duckduckgo`：遗留选项（目标 UOS 环境实测不可达）。
 * - `none`：禁用搜索。
 *
 * 输出格式对齐 `tool-executor.webSearch()` 的 "Query/Source/Results" 文本结构，
 * 同为 20000 字符截断上限。
 */
import type { SearchEngine, SearchRuntimeConfig } from '../../config/config-store';
import { log, logError, logWarn } from '../../utils/logger';

export type { SearchEngine };
export type { SearchRuntimeConfig as SearchEndpointConfig };

export const SEARCH_RESULT_CHAR_LIMIT = 20000;

/** 查询缓存 TTL：24h。同一 query 归一化后命中即返回，减少爬取频率（降风控风险）+ 省 token。 */
export const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  text: string;
  expiresAt: number;
}

const queryCache = new Map<string, CacheEntry>();

export function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function getCachedSearchResult(query: string, now = Date.now()): string | null {
  const key = normalizeSearchQuery(query);
  const entry = queryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    queryCache.delete(key);
    return null;
  }
  return entry.text;
}

export function setCachedSearchResult(query: string, text: string, now = Date.now()): void {
  const key = normalizeSearchQuery(query);
  if (queryCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = queryCache.keys().next().value;
    if (oldest !== undefined) queryCache.delete(oldest);
  }
  queryCache.set(key, { text, expiresAt: now + SEARCH_CACHE_TTL_MS });
}

/** 单测/调试用：清空查询缓存。 */
export function clearSearchCache(): void {
  queryCache.clear();
}

export interface ResolvedSearchEndpoint {
  engine: SearchEngine;
  apiKey: string;
  timeoutMs: number;
}

/**
 * 内网地址判定（保密 fail-closed 用）。
 * 模型 baseUrl 落到以下范围 → 视为内网/离线部署，
 * 联网检索自动禁用（用户无需手动再关一次）。
 */
export function isIntranetEndpoint(rawUrl: string): boolean {
  const url = rawUrl.trim().toLowerCase();
  if (!url) return false;
  let host = '';
  try {
    host = new URL(url.includes('://') ? url : `http://${url}`).hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host === '127.0.0.1') return true;
  if (/^(10|192\.168)\./.test(host)) return true;
  const m172 = /^172\.(\d+)\./.exec(host);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (/\.(local|lan|internal|intranet|corp)$/.test(host)) return true;
  return false;
}

/**
 * 从 AppConfig 解析 search endpoint 配置。
 * 挂靠独立的 searchRuntime 配置段，不嵌套进 memoryRuntime。
 *
 * 保密 fail-closed：模型 baseUrl 为内网地址时，无论用户选了什么引擎，
 * 一律强制 engine='none'（涉密环境切内网模型即自动断网，无需再手动禁用）。
 */
export function resolveSearchEndpoint(appConfig?: {
  searchRuntime?: Partial<SearchRuntimeConfig>;
  baseUrl?: string;
}): ResolvedSearchEndpoint {
  const raw = appConfig?.searchRuntime;
  // fail-closed 默认：未配置/非法值一律 'none'（与 config-store normalize 一致，
  // 此处兜底仅防绕开 normalize 的直接调用）。
  const VALID_ENGINES: SearchEngine[] = [
    'bing-cn',
    'sogou',
    'chrome-mcp',
    'bing-api',
    'serper',
    'duckduckgo',
    'none',
  ];
  const engine: SearchEngine =
    raw?.engine && VALID_ENGINES.includes(raw.engine) ? raw.engine : 'none';
  const configured: ResolvedSearchEndpoint = {
    engine,
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : '',
    timeoutMs:
      typeof raw?.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
        ? raw.timeoutMs
        : 10000,
  };
  if (configured.engine !== 'none' && appConfig?.baseUrl && isIntranetEndpoint(appConfig.baseUrl)) {
    logWarn(
      `[SubagentSearch] intranet model endpoint (${appConfig.baseUrl}) — forcing search engine to 'none'`
    );
    return { ...configured, engine: 'none' };
  }
  return configured;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchHtml(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Search request failed with status ${response.status}`);
  }
  return response.text();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface SearchHit {
  title: string;
  snippet: string;
  url: string;
}

/**
 * Bing 中国版结果页解析（纯函数，可单测；fixture 见 tests/claude/subagent/）。
 * 主路径提取 <li class="b_algo"> 块的标题 / 摘要 / 真实链接；
 * 页面改版导致类名变化时，降级用通用 <h2><a> 链接提取（有标题+URL、无摘要），
 * 总比零结果强——child 至少能拿到可打开的链接。
 */
export function parseBingCnResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blockPattern = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(html)) !== null && hits.length < 10) {
    const inner = block[1];
    const linkPattern = /<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    const link = linkPattern.exec(inner);
    if (!link) continue;
    const snippetPattern = /<(?:p|div)[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i;
    const snippet = snippetPattern.exec(inner);
    const title = stripHtml(link[2]);
    if (!title) continue;
    // Bing 的 href 可能是跳转链接（/ck/a?...&u=a1<base64>），尽量还原真实目标
    const url = decodeBingRedirect(link[1]);
    hits.push({ title, snippet: snippet ? stripHtml(snippet[1]).slice(0, 300) : '', url });
  }
  if (hits.length > 0) return hits;
  // 降级：不限定 li 类名，直接抓 h2 标题链接（改版后保底）
  const fallbackPattern = /<h2>\s*<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = fallbackPattern.exec(html)) !== null && hits.length < 10) {
    const title = stripHtml(m[2]);
    if (!title) continue;
    const url = decodeBingRedirect(m[1]);
    if (hits.some((h) => h.url === url)) continue;
    hits.push({ title, snippet: '', url });
  }
  return hits;
}

function decodeBingRedirect(href: string): string {
  try {
    if (!href.includes('/ck/a')) return href;
    const parsed = new URL(href, 'https://cn.bing.com');
    const u = parsed.searchParams.get('u');
    if (!u) return href;
    // u=a1<base64> 形态：去掉 a1 前缀后 base64 解码
    const b64 = u.replace(/^a\d/, '');
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    if (/^https?:\/\//.test(decoded)) return decoded;
    return href;
  } catch {
    return href;
  }
}

/**
 * 搜狗结果页解析（纯函数，可单测）。提取 .vrwrap / .rb 块的标题与摘要。
 */
export function parseSogouResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blockPattern =
    /<(?:div|li)[^>]*class="[^"]*\b(?:vrwrap|rb)\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|li)>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(html)) !== null && hits.length < 10) {
    const inner = block[1];
    const linkPattern = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    const altPattern = /<a[^>]*class="[^"]*\bpt_tit\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    const link = linkPattern.exec(inner) ?? altPattern.exec(inner);
    if (!link) continue;
    const title = stripHtml(link[2]);
    if (!title) continue;
    hits.push({ title, snippet: '', url: link[1] });
  }
  return hits;
}

function formatHits(query: string, source: string, hits: SearchHit[]): string {
  const lines = [`Query: ${query}`, `Source: ${source}`];
  if (hits.length === 0) {
    lines.push('Results: No related results found.');
  } else {
    lines.push('Results:');
    for (const hit of hits) {
      lines.push(`- ${hit.title}${hit.url ? ` (${hit.url})` : ''}`);
      if (hit.snippet) lines.push(`  ${hit.snippet}`);
    }
  }
  const output = lines.join('\n');
  return output.length > SEARCH_RESULT_CHAR_LIMIT
    ? `${output.slice(0, SEARCH_RESULT_CHAR_LIMIT)}\n\n[Truncated ${output.length - SEARCH_RESULT_CHAR_LIMIT} chars]`
    : output;
}

async function callBingCn(query: string, timeoutMs: number): Promise<string> {
  const url = `https://cn.bing.com/search?${new URLSearchParams({ q: query, FORM: 'QBLH' })}`;
  const html = await fetchHtml(url, timeoutMs);
  // 风控/验证页直接抛错（带明确原因），而不是静默返回零结果——
  // 零结果会让 child 误以为"查无此事"，明确报错 child 才知道是通道问题。
  if (isLikelyBlockedPage(html)) {
    throw new Error(
      'Bing 返回了验证/拦截页（疑似请求被风控拦截）。可切换搜索引擎（设置 → 通用 → 联网检索）后重试。'
    );
  }
  const hits = parseBingCnResults(html);
  if (hits.length === 0) {
    logWarn(`[SubagentSearch] bing-cn parsed 0 hits, htmlChars=${html.length}`);
  }
  return formatHits(query, 'Bing (cn.bing.com)', hits);
}

/**
 * 粗检验证/拦截页（Bing 高频访问或 UA 异常时会返回 200 验证页，
 * 解析器对其只能产出零结果——提前识别、明确报错）。
 */
export function isLikelyBlockedPage(html: string): boolean {
  return /captcha|unusual traffic|sb_error|人机验证|身份验证|访问被拒绝|请完成.*验证/i.test(html);
}

async function callSogou(query: string, timeoutMs: number): Promise<string> {
  const url = `https://www.sogou.com/web?${new URLSearchParams({ query })}`;
  const html = await fetchHtml(url, timeoutMs);
  if (isLikelyBlockedPage(html)) {
    throw new Error(
      '搜狗返回了验证/拦截页（疑似请求被风控拦截）。可切换搜索引擎（设置 → 通用 → 联网检索）后重试。'
    );
  }
  return formatHits(query, 'Sogou (www.sogou.com)', parseSogouResults(html));
}

async function callDuckDuckGo(query: string, timeoutMs: number): Promise<string> {
  const searchUrl = new URL('https://api.duckduckgo.com/');
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('format', 'json');
  searchUrl.searchParams.set('no_redirect', '1');
  searchUrl.searchParams.set('no_html', '1');
  searchUrl.searchParams.set('skip_disambig', '1');
  const response = await fetch(searchUrl.toString(), {
    headers: { 'User-Agent': 'open-cowork' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Search request failed with status ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const lines = [`Query: ${query}`, 'Source: DuckDuckGo Instant Answer'];
  if (typeof data.Heading === 'string' && data.Heading) lines.push(`Heading: ${data.Heading}`);
  if (typeof data.AbstractText === 'string' && data.AbstractText) {
    lines.push(`Abstract: ${data.AbstractText}`);
  }
  const output = lines.join('\n');
  return output.length > SEARCH_RESULT_CHAR_LIMIT
    ? `${output.slice(0, SEARCH_RESULT_CHAR_LIMIT)}\n\n[Truncated ${output.length - SEARCH_RESULT_CHAR_LIMIT} chars]`
    : output;
}

async function callBingApi(query: string, apiKey: string, timeoutMs: number): Promise<string> {
  const url = `https://api.bing.microsoft.com/v7.0/search?${new URLSearchParams({ q: query, count: '10', mkt: 'zh-CN' })}`;
  const response = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Search request failed with status ${response.status}`);
  }
  const data = (await response.json()) as {
    webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> };
  };
  const hits: SearchHit[] = (data.webPages?.value ?? []).slice(0, 10).map((item) => ({
    title: item.name ?? '',
    snippet: (item.snippet ?? '').slice(0, 300),
    url: item.url ?? '',
  }));
  return formatHits(query, 'Bing Search API', hits);
}

async function callSerper(query: string, apiKey: string, timeoutMs: number): Promise<string> {
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 10, hl: 'zh-cn' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Search request failed with status ${response.status}`);
  }
  const data = (await response.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  const hits: SearchHit[] = (data.organic ?? []).slice(0, 10).map((item) => ({
    title: item.title ?? '',
    snippet: (item.snippet ?? '').slice(0, 300),
    url: item.link ?? '',
  }));
  return formatHits(query, 'Serper.dev', hits);
}

/**
 * 执行搜索并返回统一格式文本（带 24h 查询缓存）。
 * 错误透传给上层（dispatch_agent 的 execute 转为工具错误文本）。
 */
export async function performSearch(
  query: string,
  cfg: ResolvedSearchEndpoint,
  now = Date.now()
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('Query is required');
  if (cfg.engine === 'none') throw new Error('Search is disabled by configuration');

  const cached = getCachedSearchResult(trimmed, now);
  if (cached !== null) {
    log(`[SubagentSearch] cache hit: ${trimmed.slice(0, 80)}`);
    return cached;
  }

  const timeoutMs = cfg.timeoutMs ?? 10000;
  let text: string;
  try {
    switch (cfg.engine) {
      case 'bing-cn':
        text = await callBingCn(trimmed, timeoutMs);
        break;
      case 'sogou':
        text = await callSogou(trimmed, timeoutMs);
        break;
      case 'duckduckgo':
        text = await callDuckDuckGo(trimmed, timeoutMs);
        break;
      case 'bing-api':
        if (!cfg.apiKey) throw new Error('Bing Search API key not configured');
        text = await callBingApi(trimmed, cfg.apiKey, timeoutMs);
        break;
      case 'serper':
        if (!cfg.apiKey) throw new Error('Serper.dev API key not configured');
        text = await callSerper(trimmed, cfg.apiKey, timeoutMs);
        break;
      case 'chrome-mcp':
        throw new Error(
          'chrome-mcp engine does not provide web_search; use the Chrome MCP browsing tools instead'
        );
      default:
        throw new Error(`Unknown search engine: ${cfg.engine}`);
    }
  } catch (error) {
    logError('[SubagentSearch] search failed:', error);
    throw error;
  }

  setCachedSearchResult(trimmed, text, now);
  return text;
}

/** 失败结果也缓存短时间，避免模型反复重试同一 query 触发风控。 */
export function cacheSearchFailure(query: string, now = Date.now()): void {
  logWarn(`[SubagentSearch] caching failure marker for: ${query.slice(0, 80)}`);
  setCachedSearchResult(query, 'Results: Search temporarily unavailable, please try again later.', now);
}
