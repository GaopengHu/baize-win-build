/**
 * search-endpoint 回归（Phase 7.1）：
 * - bing-cn / sogou 结果页解析（内联 fixture，页面改版时先红测试）
 * - 24h 查询缓存：命中、归一化、TTL 过期
 * - resolveSearchEndpoint 默认值
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  parseBingCnResults,
  parseSogouResults,
  isLikelyBlockedPage,
  resolveSearchEndpoint,
  getCachedSearchResult,
  setCachedSearchResult,
  clearSearchCache,
  normalizeSearchQuery,
  SEARCH_CACHE_TTL_MS,
} from '../../../src/main/claude/subagent/search-endpoint';

const BING_FIXTURE = `
<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/a">Example A 标题</a></h2>
<p class="b_caption">摘要 A 内容 <span>more</span></p></li>
<li class="b_algo"><h2><a href="https://example.com/b">Example B</a></h2></li>
<li class="b_ad">广告位，应被忽略</li>
</ol></body></html>`;

const SOGOU_FIXTURE = `
<html><body><div id="main">
<div class="vrwrap"><h3><a href="https://example.com/s1">搜狗结果一</a></h3></div>
<li class="rb"><h3><a href="https://example.com/s2">搜狗结果二</a></h3></li>
</div></body></html>`;

beforeEach(() => {
  clearSearchCache();
});

describe('bing-cn parser', () => {
  it('extracts title/snippet/url from b_algo blocks', () => {
    const hits = parseBingCnResults(BING_FIXTURE);
    expect(hits).toHaveLength(2);
    expect(hits[0].title).toBe('Example A 标题');
    expect(hits[0].url).toBe('https://example.com/a');
    expect(hits[0].snippet).toMatch(/摘要 A 内容/);
    expect(hits[1].title).toBe('Example B');
  });

  it('falls back to generic h2 links when b_algo classes change (page redesign)', () => {
    const redesigned = `<html><body><ol id="b_results">
<li class="b_newcard"><h2><a href="https://example.com/x">改版后标题</a></h2></li>
</ol></body></html>`;
    const hits = parseBingCnResults(redesigned);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('改版后标题');
    expect(hits[0].url).toBe('https://example.com/x');
  });

  it('detects captcha/block pages instead of returning silent zero hits', () => {
    expect(
      isLikelyBlockedPage('<html><body>Please complete the captcha verification</body></html>')
    ).toBe(true);
    expect(isLikelyBlockedPage('<html><body>请完成人机验证后继续</body></html>')).toBe(true);
    expect(isLikelyBlockedPage(BING_FIXTURE)).toBe(false);
  });
});

describe('sogou parser', () => {
  it('extracts vrwrap/rb blocks', () => {
    const hits = parseSogouResults(SOGOU_FIXTURE);
    expect(hits).toHaveLength(2);
    expect(hits[0].title).toBe('搜狗结果一');
    expect(hits[0].url).toBe('https://example.com/s1');
  });
});

describe('search cache', () => {
  it('hits on normalized queries within TTL', () => {
    const now = Date.now();
    setCachedSearchResult('  X 公司  最新动态 ', 'cached-text', now);
    expect(getCachedSearchResult('x 公司 最新动态', now)).toBe('cached-text');
  });

  it('expires after 24h', () => {
    const now = Date.now();
    setCachedSearchResult('q', 'v', now);
    expect(getCachedSearchResult('q', now + SEARCH_CACHE_TTL_MS + 1000)).toBeNull();
    expect(SEARCH_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('normalizes whitespace and case', () => {
    expect(normalizeSearchQuery('  A   B\tC ')).toBe('a b c');
  });
});

describe('resolveSearchEndpoint', () => {
  it('defaults to none with 10s timeout (fail-closed)', () => {
    expect(resolveSearchEndpoint(undefined)).toEqual({ engine: 'none', timeoutMs: 10000 });
    expect(resolveSearchEndpoint({})).toEqual({ engine: 'none', timeoutMs: 10000 });
  });

  it('forces engine none for intranet model endpoints (fail-closed, no manual step)', () => {
    for (const baseUrl of [
      'http://localhost:8000/v1',
      'http://127.0.0.1:11434/v1',
      'http://10.1.2.3:8000/v1',
      'http://192.168.1.100:8000/v1',
      'http://172.20.0.5:8000/v1',
      'http://llm.corp.local/v1',
      'http://model.internal/v1',
    ]) {
      expect(resolveSearchEndpoint({ baseUrl }).engine).toBe('none');
      // 显式选了引擎也照样强制禁用
      expect(resolveSearchEndpoint({ baseUrl, searchRuntime: { engine: 'bing-cn' } }).engine).toBe(
        'none'
      );
    }
    // 公网地址不受影响（默认仍为 none，需用户显式开启）
    expect(resolveSearchEndpoint({ baseUrl: 'https://openrouter.ai/api/v1' }).engine).toBe('none');
    // 用户显式选择的引擎在公网地址下生效
    expect(
      resolveSearchEndpoint({
        baseUrl: 'https://openrouter.ai/api/v1',
        searchRuntime: { engine: 'bing-cn' },
      }).engine
    ).toBe('bing-cn');
    // 非法引擎值回落到 none（fail-closed）
    expect(
      resolveSearchEndpoint({
        searchRuntime: { engine: 'not-a-engine' as never },
      }).engine
    ).toBe('none');
    expect(
      resolveSearchEndpoint({
        baseUrl: 'https://openrouter.ai/api/v1',
        searchRuntime: { engine: 'none' },
      }).engine
    ).toBe('none');
  });
});
