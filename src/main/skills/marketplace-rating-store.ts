/**
 * @module main/skills/marketplace-rating-store
 *
 * 技能评分端侧凭证的主进程持久化。
 *
 * 背景：下载/评分记录如果只放在渲染层 localStorage（Chromium 的
 * `Local Storage/` 目录），用户删掉那个文件夹（或重装清数据）就能重置
 * “半年一次”的冷却，重新评分。服务端匿名接口又不去重，等于门控被绕过。
 *
 * 对策：同一份状态在主进程再存一份（userData 根目录下的独立 JSON 文件，
 * 与 Chromium 的 Local Storage 物理隔离）。渲染层仍用 localStorage 做
 * 同步读写保证交互不卡，但每次打开商店时用主进程的这份做合并校准：
 * 删 Local Storage 文件夹 → 下次打开自动从主进程备份恢复，冷却继续算。
 *
 * deviceId 同样主进程签发并持久化，保证同一台机器长期稳定，服务端审计
 * 才能关联；渲染层每次采用主进程的 ID，不自己另起一个。
 *
 * 注意：这防的是“随手删文件夹/重装”级别的绕过。真有人把整个 userData
 * （含本文件）全删了重来，那和换了一台新设备无异，端侧已无法区分，
 * 最终去重要靠服务端按 device_id + app_id 加唯一约束（后端改动）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface MarketplaceRatingState {
  deviceId: string;
  /** appId -> 下载时间戳（毫秒）。 */
  downloaded: Record<string, number>;
  /** appId -> 上次评分时间戳（毫秒）。 */
  ratings: Record<string, number>;
}

const STORE_FILENAME = 'marketplace-ratings.json';

function isRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => typeof v === 'number' && Number.isFinite(v)
  );
}

export class MarketplaceRatingStore {
  private readonly filePath: string;
  private state: MarketplaceRatingState | null = null;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, STORE_FILENAME);
  }

  /** 全量状态（不存在则初始化并落盘）。 */
  getState(): MarketplaceRatingState {
    if (!this.state) {
      this.state = this.load();
    }
    return {
      deviceId: this.state.deviceId,
      downloaded: { ...this.state.downloaded },
      ratings: { ...this.state.ratings },
    };
  }

  markDownloaded(appId: number): MarketplaceRatingState {
    const state = this.getState();
    if (Number.isFinite(appId)) {
      state.downloaded[String(appId)] = Date.now();
      this.save(state);
    }
    return state;
  }

  recordRating(appId: number, keyFingerprint = ''): MarketplaceRatingState {
    const state = this.getState();
    if (Number.isFinite(appId)) {
      // 评分按 Key 隔离：同一机器换 Key = 换用户，各自独立冷却。
      // 每次调用现算指纹，不缓存——用户在设置里换 Key 后立即生效。
      const fp = (keyFingerprint || '').trim();
      const key = fp ? `${fp}:${appId}` : String(appId);
      state.ratings[key] = Date.now();
      this.save(state);
    }
    return state;
  }

  private load(): MarketplaceRatingState {
    const fallback: MarketplaceRatingState = {
      deviceId: randomUUID(),
      downloaded: {},
      ratings: {},
    };
    try {
      if (!fs.existsSync(this.filePath)) {
        this.persist(fallback);
        return fallback;
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Record<string, unknown>;
      const deviceId = typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : randomUUID();
      const downloaded = isRecord(raw.downloaded) ? (raw.downloaded as Record<string, number>) : {};
      const ratings = isRecord(raw.ratings) ? (raw.ratings as Record<string, number>) : {};
      const state: MarketplaceRatingState = { deviceId, downloaded, ratings };
      // 顺手修复脏文件，保证下次直接可用
      this.persist(state);
      return state;
    } catch {
      return fallback;
    }
  }

  private save(state: MarketplaceRatingState): void {
    this.state = state;
    this.persist(state);
  }

  private persist(state: MarketplaceRatingState): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
      this.state = state;
    } catch {
      // 磁盘不可写时仅内存生效，本次会话内门控依然有效
    }
  }
}
