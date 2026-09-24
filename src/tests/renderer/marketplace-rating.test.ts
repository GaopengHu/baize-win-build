/**
 * marketplace-rating 门控逻辑回归：
 * - 半年冷却：182 天内不允许对同一 skill 再次评分
 * - 评分档位：仅 0.5 步进合法
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  RATING_COOLDOWN_MS,
  getRateEligibility,
  recordRating,
  isValidRatingStep,
  formatCooldownDays,
  markSkillDownloaded,
  isSkillDownloaded,
  applyPersistedRatingState,
} from '../../renderer/utils/marketplace-rating';

const DAY = 24 * 60 * 60 * 1000;

// vitest 环境是 node，没有 localStorage；注入一个内存实现给门控逻辑用。
function installLocalStorageMock() {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
  };
  vi.stubGlobal('localStorage', mock);
}

beforeEach(() => {
  installLocalStorageMock();
});

describe('marketplace rating gate', () => {
  it('cooldown is 182 days', () => {
    expect(RATING_COOLDOWN_MS).toBe(182 * DAY);
  });

  it('allows first rating', () => {
    expect(getRateEligibility(42).allowed).toBe(true);
  });

  it('blocks re-rating within half a year', () => {
    const now = Date.now();
    recordRating(42, '', now - 100 * DAY);
    const result = getRateEligibility(42, '', now);
    expect(result.allowed).toBe(false);
    expect(result.remainingMs).toBeGreaterThan(0);
    expect(formatCooldownDays(result.remainingMs)).toBe(82);
  });

  it('allows rating again after cooldown expires', () => {
    const now = Date.now();
    recordRating(42, '', now - 182 * DAY - 1000);
    expect(getRateEligibility(42, '', now).allowed).toBe(true);
  });

  it('tracks ratings per app independently', () => {
    const now = Date.now();
    recordRating(1, '', now);
    expect(getRateEligibility(1, '', now).allowed).toBe(false);
    expect(getRateEligibility(2, '', now).allowed).toBe(true);
  });

  it('isolates quotas per API key fingerprint', () => {
    const now = Date.now();
    recordRating(5, 'fp-user-a', now);
    // 同一 Key 被拦
    expect(getRateEligibility(5, 'fp-user-a', now).allowed).toBe(false);
    // 换 Key = 换用户，可评（同一机器多用户不互抢）
    expect(getRateEligibility(5, 'fp-user-b', now).allowed).toBe(true);
    // 无 Key 退化为裸 appId
    expect(getRateEligibility(5, '', now).allowed).toBe(true);
  });

  it('reads legacy unscoped records (pre-upgrade compatibility)', () => {
    const now = Date.now();
    recordRating(6, '', now);
    expect(getRateEligibility(6, 'fp-new-key', now).allowed).toBe(false);
  });

  it('accepts only 0.5 steps in 0.5..5', () => {
    for (const s of [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]) {
      expect(isValidRatingStep(s)).toBe(true);
    }
    for (const s of [0, 0.4, 3.7, 4.2, 5.5, -1, NaN]) {
      expect(isValidRatingStep(s)).toBe(false);
    }
  });

  it('records downloads for the rating gate', () => {
    expect(isSkillDownloaded(7)).toBe(false);
    markSkillDownloaded(7);
    expect(isSkillDownloaded(7)).toBe(true);
    expect(isSkillDownloaded(8)).toBe(false);
  });

  it('restores gate state from main-process backup after local wipe', () => {
    const now = Date.now();
    // 模拟：曾经下载并评分，随后用户删掉了 Local Storage 文件夹
    markSkillDownloaded(9);
    recordRating(9, '', now - 10 * DAY);
    localStorage.clear();
    expect(isSkillDownloaded(9)).toBe(false);
    expect(getRateEligibility(9, '', now).allowed).toBe(true);
    // 下次打开商店，主进程备份把状态校准回来
    applyPersistedRatingState({
      deviceId: 'device-main-001',
      downloaded: { '9': now - 20 * DAY },
      ratings: { '9': now - 10 * DAY },
    });
    expect(isSkillDownloaded(9)).toBe(true);
    expect(getRateEligibility(9, '', now).allowed).toBe(false);
    expect(localStorage.getItem('nowlink.device-id.v1')).toBe('device-main-001');
  });

  it('keeps the earlier rating timestamp when merging (no cooldown refresh)', () => {
    const now = Date.now();
    recordRating(11, '', now - 100 * DAY);
    applyPersistedRatingState({
      deviceId: 'device-main-001',
      downloaded: {},
      // 备份里是更早的一次评分，合并后冷却仍从更早那次算起
      ratings: { '11': now - 150 * DAY },
    });
    const result = getRateEligibility(11, '', now);
    expect(result.allowed).toBe(false);
    expect(formatCooldownDays(result.remainingMs)).toBe(32);
  });
});
