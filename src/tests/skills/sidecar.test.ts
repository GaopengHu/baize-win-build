/**
 * Sidecar（.nowlink-marketplace.json）读写测试：
 * - 新格式全字段往返
 * - 旧格式 { appId, displayName } 兼容读（→ source: 'marketplace'）
 * - 无 sidecar / 损坏 JSON → null（调用方回退「本地」展示）
 * - 写入默认 source: 'local' + installedAt
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  userData: '',
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => mockState.userData,
    getVersion: () => '0.0.0-test',
    getAppPath: () => mockState.userData,
  },
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  loadSkillsFromDir: vi.fn(() => []),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  skillSidecarPath,
  readSkillSidecar,
  writeSkillSidecar,
  readMarketplaceDisplayName,
} from '../../main/skills/skills-manager';

let tmpRoot: string;
let skillDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nowlink-sidecar-'));
  mockState.userData = tmpRoot;
  skillDir = path.join(tmpRoot, 'my-skill');
  fs.mkdirSync(skillDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('skillSidecarPath', () => {
  it('points to .nowlink-marketplace.json inside the skill directory', () => {
    expect(skillSidecarPath(skillDir)).toBe(path.join(skillDir, '.nowlink-marketplace.json'));
  });
});

describe('writeSkillSidecar + readSkillSidecar round-trip', () => {
  it('preserves all marketplace fields', () => {
    writeSkillSidecar(skillDir, {
      appId: 42,
      displayName: '文档处理',
      version: '1.2.0',
      installedAt: 1700000000000,
      source: 'marketplace',
    });

    const sidecar = readSkillSidecar(skillDir);
    expect(sidecar).toEqual({
      appId: 42,
      displayName: '文档处理',
      version: '1.2.0',
      installedAt: 1700000000000,
      source: 'marketplace',
    });
  });

  it('defaults to source local and stamps installedAt when omitted', () => {
    const before = Date.now();
    writeSkillSidecar(skillDir, {});
    const after = Date.now();

    const sidecar = readSkillSidecar(skillDir);
    expect(sidecar?.source).toBe('local');
    expect(sidecar?.installedAt).toBeGreaterThanOrEqual(before);
    expect(sidecar?.installedAt).toBeLessThanOrEqual(after);
    expect(sidecar?.appId).toBeUndefined();
  });

  it('normalizes unknown source values to local on write', () => {
    writeSkillSidecar(skillDir, { source: 'garbage' as unknown as 'local' });
    expect(readSkillSidecar(skillDir)?.source).toBe('local');
  });
});

describe('readSkillSidecar compatibility', () => {
  it('reads legacy { appId, displayName } format as marketplace', () => {
    fs.writeFileSync(
      skillSidecarPath(skillDir),
      JSON.stringify({ appId: 7, displayName: '旧版技能' }),
      'utf-8'
    );

    const sidecar = readSkillSidecar(skillDir);
    expect(sidecar).toEqual({ appId: 7, displayName: '旧版技能', source: 'marketplace' });
  });

  it('returns null when there is no sidecar file', () => {
    expect(readSkillSidecar(skillDir)).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    fs.writeFileSync(skillSidecarPath(skillDir), '{ not json !!!', 'utf-8');
    expect(readSkillSidecar(skillDir)).toBeNull();
  });

  it('returns null when JSON is not an object', () => {
    fs.writeFileSync(skillSidecarPath(skillDir), '42', 'utf-8');
    expect(readSkillSidecar(skillDir)).toBeNull();
  });

  it('ignores malformed field values', () => {
    fs.writeFileSync(
      skillSidecarPath(skillDir),
      JSON.stringify({
        appId: 'not-a-number',
        displayName: '   ',
        version: 3,
        installedAt: 'yesterday',
        source: 'local',
      }),
      'utf-8'
    );

    const sidecar = readSkillSidecar(skillDir);
    expect(sidecar).toEqual({ source: 'local' });
  });

  it('trims string fields', () => {
    fs.writeFileSync(
      skillSidecarPath(skillDir),
      JSON.stringify({ displayName: '  技能名  ', version: ' 2.0.0 ', source: 'marketplace' }),
      'utf-8'
    );

    const sidecar = readSkillSidecar(skillDir);
    expect(sidecar?.displayName).toBe('技能名');
    expect(sidecar?.version).toBe('2.0.0');
  });
});

describe('readMarketplaceDisplayName', () => {
  it('delegates to the sidecar displayName', () => {
    writeSkillSidecar(skillDir, { displayName: '表格助手', source: 'marketplace' });
    expect(readMarketplaceDisplayName(skillDir)).toBe('表格助手');
  });

  it('returns null without a sidecar', () => {
    expect(readMarketplaceDisplayName(skillDir)).toBeNull();
  });
});
