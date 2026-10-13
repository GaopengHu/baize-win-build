/**
 * @module main/skills/company-marketplace-service
 *
 * Client for the company AI platform ("今点通" 应用市场) public app API.
 *
 * Endpoints (verified against 172.26.110.88:3000):
 * - GET  {base}/api/apps/public?category=Skill → app list **with packages[]**
 *   (this is the endpoint that returns installable packages; `/api/apps` returns
 *   the same apps but omits packages, so it is only used as a fallback)
 * - GET  {base}/api/apps/icon/{appId}          → icon binary
 * - GET  {base}/api/apps/download/{appId}?package_id={pkgId} → package binary (zip)
 *
 * Downloads are anonymous on this server. An optional bearer token can still
 * be provided for environments that require one.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log, logWarn } from '../utils/logger';

const DEFAULT_BASE_URL = 'http://172.31.30.155:3000';
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

export interface MarketplacePackage {
  id: number;
  app_id: number;
  name: string;
  arch: string;
  file_size: number;
  sort: number;
  created: number;
}

export interface MarketplaceApp {
  id: number;
  name: string;
  description: string;
  icon: string;
  version: string;
  screenshots: string[];
  category: string;
  tags: string[];
  download_count: number;
  updated_time: number;
  packages: MarketplacePackage[];
  /** 服务端下发的平均分（0~5，保留一位小数）；缺失时为 null。 */
  avg_score: number | null;
  /** 服务端下发的评价次数。 */
  rating_count: number;
}

export interface MarketplaceRatingResult {
  avg_score: number;
  rating_count: number;
}

interface MarketplaceEnvelope {
  success: boolean;
  message: string;
  data?: unknown;
}

export class MarketplaceHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MarketplaceHttpError';
    this.status = status;
  }
}

/**
 * 服务端凭证规则（对照 app-rating-curl.md §2.4）：
 * - 必须 `sk-` 开头，否则被当成网页 access token；
 * - key 本体不能含 `-`（服务端按第一个 `-` 截取，含 `-` 直接判无效）。
 * 不满足的 key 还不如不带：带了会被 401，还不如直接匿名走 IP 桶。
 */
export function toMarketplaceAuthToken(rawKey: string): string {
  const key = (rawKey || '').trim();
  if (!/^sk-[A-Za-z0-9]+$/.test(key)) {
    return '';
  }
  return key;
}

export class CompanyMarketplaceService {
  private baseUrl: string;
  private accessToken: string;

  constructor(baseUrl = DEFAULT_BASE_URL, accessToken = '') {
    this.baseUrl = CompanyMarketplaceService.normalizeBaseUrl(baseUrl);
    this.accessToken = accessToken.trim();
  }

  static normalizeBaseUrl(value: string): string {
    const trimmed = (value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    if (!trimmed) {
      return DEFAULT_BASE_URL;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      return `http://${trimmed}`;
    }
    return trimmed;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** 是否携带身份头（日志只用此判断，绝不输出 token 原文）。 */
  hasAccessToken(): boolean {
    return this.accessToken.length > 0;
  }

  async listSkillApps(category = 'Skill'): Promise<MarketplaceApp[]> {
    const query = `category=${encodeURIComponent(category)}`;
    // `/api/apps/public` is the catalog endpoint that includes packages[].
    // `/api/apps` returns the same apps without packages, so it can only serve
    // as a fallback (its results are then not installable).
    const candidates = [`${this.baseUrl}/api/apps/public?${query}`, `${this.baseUrl}/api/apps?${query}`];
    let firstError: unknown = null;

    for (const url of candidates) {
      try {
        const payload = await this.requestJsonWithAuthFallback<MarketplaceEnvelope>(url);
        if (!payload?.success) {
          throw new MarketplaceHttpError(200, payload?.message || 'Marketplace request failed');
        }
        if (!Array.isArray(payload.data)) {
          throw new Error('Marketplace returned unexpected data shape');
        }
        const apps = payload.data
          .map((raw) => this.parseApp(raw))
          .filter((app): app is MarketplaceApp => app !== null)
          // The catalog endpoint filters by category server-side, but keep a
          // client-side guard so non-skill apps never leak into the UI.
          .filter((app) => !category || app.category.toLowerCase() === category.toLowerCase());
        if (apps.length > 0 || url === candidates[candidates.length - 1]) {
          return apps;
        }
      } catch (error) {
        if (firstError === null) {
          firstError = error;
        }
      }
    }

    throw firstError instanceof Error
      ? firstError
      : new Error('Marketplace request failed for all catalog endpoints');
  }

  /**
   * Download a package to a temp file and return its path.
   * Caller is responsible for deleting the file afterwards.
   */
  async downloadPackage(appId: number, packageId: number): Promise<string> {
    const url = `${this.baseUrl}/api/apps/download/${encodeURIComponent(appId)}?package_id=${encodeURIComponent(packageId)}`;
    // 身份头由调用方经 accessToken 传入（当前为下载时透传的用户模型 API Key）。
    // 日志只记有无、不记原文；Key 本身只出现在本请求的 Authorization 头里。
    log(`[Marketplace] downloading package appId=${appId} packageId=${packageId} authed=${this.hasAccessToken()}`);
    const response = await this.requestRaw(url, DOWNLOAD_TIMEOUT_MS);
    // 429 限流 body 可能为空，先看状态码（与评分接口同理）
    if (response.status === 429) {
      throw new MarketplaceHttpError(429, '下载过于频繁，请稍后再试（可能与评分共用员工额度）');
    }
    if (!response.ok) {
      const message = await this.extractErrorMessage(response);
      throw new MarketplaceHttpError(
        response.status,
        `Package download failed (${response.status})${message ? `: ${message}` : ''}`
      );
    }

    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_PACKAGE_BYTES) {
      throw new Error(`Package too large: ${declaredSize} bytes (limit ${MAX_PACKAGE_BYTES})`);
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowlink-skill-'));
    const tempFile = path.join(tempDir, `package-${appId}-${packageId}.zip`);
    try {
      // NOTE: the fetch available in the bundled Electron runtime returns a
      // non-standard Response whose body is neither a WHATWG ReadableStream
      // (no getReader) nor a Node stream helper (no Readable.fromWeb support).
      // arrayBuffer() is the one API proven to work there — fetchIconBytes
      // already relies on it and icons render fine — so avoid all streaming
      // APIs and buffer the whole package before writing it to disk.
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0) {
        throw new Error('Package download is empty');
      }
      if (data.length > MAX_PACKAGE_BYTES) {
        throw new Error(`Package too large after download: ${data.length} bytes`);
      }
      fs.writeFileSync(tempFile, data);
    } catch (error) {
      this.cleanupTempDir(tempDir);
      throw error;
    }

    return tempFile;
  }

  async fetchIconBytes(appId: number): Promise<{ bytes: Buffer; contentType: string } | null> {
    const url = `${this.baseUrl}/api/apps/icon/${encodeURIComponent(appId)}`;
    try {
      const response = await this.requestRaw(url, REQUEST_TIMEOUT_MS);
      if (!response.ok) {
        return null;
      }
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.startsWith('image/')) {
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        return null;
      }
      return { bytes: buffer, contentType };
    } catch {
      return null;
    }
  }

  /**
   * 端侧匿名评分：POST {base}/api/apps/public/rating/:id
   * Header Authorization: Bearer sk-<key>（用户模型 Key；不带则按出口 IP 限流）。
   * body { score: 0.5~5（0.5 步进）, device_id?, key_fp? }，Content-Type 必须 application/json。
   * 成功返回服务端合并后的最新 { avg_score, rating_count }。
   * 服务端不去重，“半年一次”由端侧（渲染层 localStorage）负责。
   *
   * key_fp 是当前模型 API Key 的 SHA-256 指纹（前 16 位 hex），绝不传原文：
   * 用户删库重装也换不掉自己的 Key，服务端将来可用 (key_fp, app_id) 做
   * 去重/限频；现阶段至少可审计。Go 侧 ShouldBindJSON 会忽略未知字段，
   * 老版本服务端收到多一个字段不会报错。
   *
   * 状态码语义（对照服务端 app-rating-curl.md）：
   * 业务失败一律 HTTP 200 + success:false（必须读 body.success，不能只看状态码）；
   * 429 限流 body 为空、只能看状态码；403 模块开关；404 旧版本二进制。
   */
  async submitRating(
    appId: number,
    score: number,
    deviceId?: string,
    keyFingerprint?: string
  ): Promise<MarketplaceRatingResult> {
    if (!Number.isFinite(appId)) {
      throw new Error('应用 ID 无效');
    }
    if (!Number.isFinite(score) || score < 0.5 || score > 5) {
      throw new Error('评分超出范围');
    }
    // 0.5 步进校验（浮点安全写法）
    if (Math.abs(score * 2 - Math.round(score * 2)) > 1e-9) {
      throw new Error('评分步长必须为 0.5');
    }
    const url = `${this.baseUrl}/api/apps/public/rating/${encodeURIComponent(appId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const body: Record<string, unknown> = {
        score,
        device_id: (deviceId || '').slice(0, 128),
      };
      if (keyFingerprint) {
        body.key_fp = keyFingerprint;
      }
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // 状态码优先（对照服务端 app-rating-curl.md §5/§6）：
      // 429 限流 body 为空，只能看状态码；403 模块开关；404 是旧版本二进制。
      // 业务失败是 HTTP 200 + success:false，走 body 的 message。
      if (response.status === 429) {
        throw new MarketplaceHttpError(429, '评分过于频繁，请稍后再试');
      }
      if (response.status === 403) {
        throw new MarketplaceHttpError(403, '技能市场模块已关闭 (apps is disabled)');
      }
      if (response.status === 404) {
        throw new MarketplaceHttpError(404, '服务端版本过旧，不支持评分接口');
      }
      let payload: MarketplaceEnvelope;
      try {
        payload = (await response.json()) as MarketplaceEnvelope;
      } catch {
        throw new MarketplaceHttpError(response.status, '评分参数无效');
      }
      if (!response.ok || !payload?.success) {
        throw new MarketplaceHttpError(
          response.status,
          payload?.message || `评分提交失败 (${response.status})`
        );
      }
      const data = (payload.data || {}) as Record<string, unknown>;
      const avg = Number(data.avg_score ?? data.avgScore);
      const count = Number(data.rating_count ?? data.ratingCount);
      if (!Number.isFinite(avg) || !Number.isFinite(count)) {
        throw new Error('评分接口返回数据异常');
      }
      return { avg_score: avg, rating_count: count };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new MarketplaceHttpError(0, `评分请求超时: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseApp(raw: unknown): MarketplaceApp | null {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const id = Number(record.id);
    if (!Number.isFinite(id)) {
      return null;
    }
    const packages = Array.isArray(record.packages)
      ? record.packages
          .map((pkg) => this.parsePackage(pkg))
          .filter((pkg): pkg is MarketplacePackage => pkg !== null)
          // 服务端按 sort 升序返回，端侧再排一次兜底（越小越靠前，选择器与文档一致）
          .sort((a, b) => a.sort - b.sort)
      : [];

    return {
      id,
      name: typeof record.name === 'string' ? record.name : `App ${id}`,
      description: typeof record.description === 'string' ? record.description : '',
      icon: typeof record.icon === 'string' ? record.icon : '',
      version: typeof record.version === 'string' ? record.version : '',
      screenshots: Array.isArray(record.screenshots)
        ? record.screenshots.filter((item): item is string => typeof item === 'string')
        : [],
      category: typeof record.category === 'string' ? record.category : 'Skill',
      tags: Array.isArray(record.tags)
        ? record.tags.filter((item): item is string => typeof item === 'string')
        : [],
      download_count: Number(record.download_count) || 0,
      updated_time: Number(record.updated_time) || 0,
      // 评分字段服务端可能用 avg_score / avgScore / score 等不同拼写，全部兼容；
      // 缺失时给 null，UI 显示"暂无评分"而不是伪造的 0 分。
      avg_score: this.parseScore(record.avg_score ?? record.avgScore ?? record.score),
      rating_count: Number(record.rating_count ?? record.ratingCount ?? record.rate_count) || 0,
      packages,
    };
  }

  private parseScore(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
      return null;
    }
    return Math.min(5, Math.max(0, num));
  }

  private parsePackage(raw: unknown): MarketplacePackage | null {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const id = Number(record.id);
    const appId = Number(record.app_id);
    if (!Number.isFinite(id)) {
      return null;
    }
    return {
      id,
      app_id: Number.isFinite(appId) ? appId : 0,
      name: typeof record.name === 'string' ? record.name : `package-${id}`,
      arch: typeof record.arch === 'string' ? record.arch : '',
      file_size: Number(record.file_size) || 0,
      sort: Number(record.sort) || 0,
      created: Number(record.created) || 0,
    };
  }

  private async requestJson<T>(url: string): Promise<T> {
    const response = await this.requestRaw(url, REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      const message = await this.extractErrorMessage(response);
      throw new MarketplaceHttpError(
        response.status,
        `Request failed (${response.status}) for ${url}${message ? `: ${message}` : ''}`
      );
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new Error(`Marketplace returned invalid JSON: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async requestRaw(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: this.buildHeaders(),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new MarketplaceHttpError(0, `Request timed out after ${timeoutMs}ms: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 401 匿名重试：身份头被服务端拒绝（过期/吊销/非市场 key）时，
   * 去掉头再试一次，退化为匿名（IP 桶）而不是直接报错。
   * 两次都 401 说明服务端要求登录，给出明确指引。
   */
  private async requestJsonWithAuthFallback<T>(url: string): Promise<T> {
    try {
      return await this.requestJson<T>(url);
    } catch (error) {
      if (
        error instanceof MarketplaceHttpError &&
        error.status === 401 &&
        this.hasAccessToken()
      ) {
        logWarn('[Marketplace] access token rejected (401), retrying anonymously');
        const saved = this.accessToken;
        this.accessToken = '';
        try {
          return await this.requestJson<T>(url);
        } catch (retryError) {
          if (retryError instanceof MarketplaceHttpError && retryError.status === 401) {
            throw new MarketplaceHttpError(
              401,
              '技能市场身份校验失败（401）。请检查模型设置中的 API 密钥是否为公司发放的 sk- 令牌'
            );
          }
          throw retryError;
        } finally {
          this.accessToken = saved;
        }
      }
      throw error;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, */*',
      'User-Agent': 'nowlink-skill-marketplace/1.0',
    };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    return headers;
  }

  private async extractErrorMessage(response: Response): Promise<string> {
    try {
      const text = await response.text();
      if (!text) {
        return '';
      }
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: { message?: string } };
        if (parsed.message) return parsed.message;
        if (parsed.error?.message) return parsed.error.message;
      } catch {
        // plain text body
      }
      return text.slice(0, 200);
    } catch {
      return '';
    }
  }

  private cleanupTempDir(tempDir: string): void {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
