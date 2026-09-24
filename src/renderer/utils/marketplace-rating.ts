/**
 * @module renderer/utils/marketplace-rating
 *
 * 端侧评分门控（localStorage 持久化）：
 * - 只有在本机点过"下载"的 skill 才能评分（下载事件由安装成功处写入）。
 * - 同一用户同一 skill 每半年只能评一次。服务端不去重（匿名接口重复提交会
 *   追加计入平均分），所以这道闸必须放在端侧，提交前强制检查。
 */

const DOWNLOADED_KEY = 'nowlink.marketplace.downloaded.v1';
const RATINGS_KEY = 'nowlink.marketplace.ratings.v1';
const DEVICE_KEY = 'nowlink.device-id.v1';

/** 半年冷却：182 天（毫秒）。 */
export const RATING_COOLDOWN_MS = 182 * 24 * 60 * 60 * 1000;

/** 评分合法档位：0.5 ~ 5，0.5 步进。 */
export const RATING_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const;

function readRecord(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeRecord(key: string, record: Record<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // 存储不可用（如隐私模式）时降级为允许流程走通，由服务端兜底
  }
}

function storageAvailable(): boolean {
  try {
    const probe = '__nowlink_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** 本机设备 ID（首次生成后持久化），随评分请求上报，仅供服务端审计。 */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && existing.length > 0) return existing.slice(0, 128);
    const generated =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `device-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
    localStorage.setItem(DEVICE_KEY, generated);
    return generated;
  } catch {
    return `device-${Date.now().toString(36)}`;
  }
}
export function isSkillDownloaded(appId: number): boolean {
  return readRecord(DOWNLOADED_KEY)[String(appId)] !== undefined;
}

export interface PersistedRatingState {
  deviceId: string;
  downloaded: Record<string, number>;
  ratings: Record<string, number>;
}

/**
 * 用主进程备份校准本地门控状态（打开商店时调用一次）。
 *
 * 合并策略（取"更严"的一边，防止任一副本被清空导致冷却重置）：
 * - deviceId：主进程为准（删 Local Storage 后仍是同一台机器）；
 * - downloaded：两边取并集；
 * - ratings：同一 skill 取更早的时间戳（冷却从第一次评算起）。
 */
export function applyPersistedRatingState(persisted: PersistedRatingState): void {
  try {
    if (persisted.deviceId) {
      localStorage.setItem(DEVICE_KEY, persisted.deviceId.slice(0, 128));
    }
    const localDownloaded = readRecord(DOWNLOADED_KEY);
    for (const [k, v] of Object.entries(persisted.downloaded || {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (localDownloaded[k] === undefined) localDownloaded[k] = v;
    }
    writeRecord(DOWNLOADED_KEY, localDownloaded);
    const localRatings = readRecord(RATINGS_KEY);
    for (const [k, v] of Object.entries(persisted.ratings || {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const local = localRatings[k];
      // 取更早者：防止"删本地 → 重评 → 刷新冷却"的绕过
      if (local === undefined || v < local) localRatings[k] = v;
    }
    writeRecord(RATINGS_KEY, localRatings);
  } catch {
    // 校准失败不阻塞商店打开，本地门控继续按现有值工作
  }
}

/** 记录一次下载事件（安装成功时调用）。返回更新后的全量表，方便 setState。 */
export function markSkillDownloaded(appId: number): Record<number, number> {
  const record = readRecord(DOWNLOADED_KEY);
  record[String(appId)] = Date.now();
  writeRecord(DOWNLOADED_KEY, record);
  return toNumericMap(record);
}

/** 读出已下载表（组件初始化用）。 */
export function loadDownloadedMap(): Record<number, number> {
  return toNumericMap(readRecord(DOWNLOADED_KEY));
}

export interface RateEligibility {
  allowed: boolean;
  /** 距上次评分的时间（毫秒），从未评过为 null。 */
  ratedAt: number | null;
  /** 距下次可评的剩余毫秒，allowed 时为 0。 */
  remainingMs: number;
}

/**
 * 评分记录的作用域键：`keyFp:appId`。
 * 同一台机器换 API Key = 换用户，额度和冷却各自独立计算（多用户共用一机不互抢）；
 * 无 Key（未配置模型）时退化为裸 appId，保证功能可用。
 * 读时兼容老版本裸 appId 记录（升级前已评过的用户不被重置）。
 */
export function scopedRatingKey(keyFp: string, appId: number): string {
  const fp = (keyFp || '').trim();
  return fp ? `${fp}:${appId}` : String(appId);
}

function lookupRating(record: Record<string, number>, keyFp: string, appId: number): number | null {
  const scoped = record[scopedRatingKey(keyFp, appId)];
  if (scoped !== undefined) return scoped;
  // 老版本裸键兜底
  const legacy = record[String(appId)];
  return legacy ?? null;
}

/** 该 skill 现在能不能评（下载过 + 该 Key 距上次评分超过半年）。 */
export function getRateEligibility(
  appId: number,
  keyFp = '',
  now = Date.now()
): RateEligibility {
  const ratedAt = lookupRating(readRecord(RATINGS_KEY), keyFp, appId);
  if (ratedAt === null) {
    return { allowed: true, ratedAt: null, remainingMs: 0 };
  }
  const remainingMs = ratedAt + RATING_COOLDOWN_MS - now;
  if (remainingMs <= 0) {
    return { allowed: true, ratedAt, remainingMs: 0 };
  }
  return { allowed: false, ratedAt, remainingMs };
}

/** 记录一次评分成功的时间戳。返回剩余毫秒（0 表示已可再评，不可能）。 */
export function recordRating(appId: number, keyFp = '', now = Date.now()): void {
  const record = readRecord(RATINGS_KEY);
  record[scopedRatingKey(keyFp, appId)] = now;
  writeRecord(RATINGS_KEY, record);
}

export function isValidRatingStep(score: number): boolean {
  return (
    Number.isFinite(score) &&
    score >= 0.5 &&
    score <= 5 &&
    Math.abs(score * 2 - Math.round(score * 2)) < 1e-9
  );
}

/** 剩余冷却换算成"X 天"（向上取整），用于提示文案。 */
export function formatCooldownDays(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
}

export function isRatingStorageAvailable(): boolean {
  return storageAvailable();
}

function toNumericMap(record: Record<string, number>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(record)) {
    const n = Number(k);
    if (Number.isFinite(n)) out[n] = v;
  }
  return out;
}
