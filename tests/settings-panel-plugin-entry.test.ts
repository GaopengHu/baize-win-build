import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// SettingsPanel was split — skills content lives in settings/SettingsSkills.tsx,
// marketplace content lives in settings/SettingsMarketplace.tsx (peer-level tab).
const root = process.cwd();
const settingsPanelPath = path.resolve(root, 'src/renderer/components/SettingsPanel.tsx');
const settingsDir = path.resolve(root, 'src/renderer/components/settings');
const marketplacePath = path.join(settingsDir, 'SettingsMarketplace.tsx');
const skillsPath = path.join(settingsDir, 'SettingsSkills.tsx');
const settingsPanelContent = readFileSync(settingsPanelPath, 'utf8');
const settingsDirContent = readdirSync(settingsDir)
  .map((f) => readFileSync(path.join(settingsDir, f), 'utf8'))
  .join('\n');
const marketplaceContent = existsSync(marketplacePath)
  ? readFileSync(marketplacePath, 'utf8')
  : '';
const skillsContent = existsSync(skillsPath) ? readFileSync(skillsPath, 'utf8') : '';

describe('SettingsPanel skills plugin browse entry', () => {
  it('registers a peer-level marketplace tab next to skills', () => {
    expect(settingsPanelContent).toContain("'marketplace'");
    expect(settingsPanelContent).toContain('SettingsMarketplace');
    expect(settingsPanelContent).toContain("t('settings.marketplace')");
    expect(settingsPanelContent).toContain("t('settings.marketplaceDesc')");
  });

  it('unit: renders marketplace list page content', () => {
    expect(marketplaceContent).toContain("t('skills.marketplaceTitle')");
    expect(marketplaceContent).toContain("t('skills.marketplaceEmpty')");
    expect(marketplaceContent).toContain("t('skills.marketplaceInstall')");
  });

  it('functional: uses marketplace IPC API for catalog, install and rating', () => {
    expect(marketplaceContent).toContain('window.electronAPI.marketplace.listSkillApps');
    expect(marketplaceContent).toContain('window.electronAPI.marketplace.installSkill');
    expect(marketplaceContent).toContain('window.electronAPI.marketplace.getBaseUrl');
    expect(marketplaceContent).toContain('window.electronAPI.marketplace.submitRating');
    expect(marketplaceContent).toContain('window.electronAPI.marketplace.getIcon');
  });

  it('functional: marketplace install relies on skills storage watcher, not cross-component calls', () => {
    // 安装后不调用技能页 loadSkills：主进程 watcher 广播 skills.storageChanged，
    // 技能页通过 store.skillsStorageChangedAt 自动刷新。
    expect(marketplaceContent).not.toContain('await loadSkills(');
    expect(marketplaceContent).not.toContain("from './SettingsSkills'");
  });

  it('functional: includes skills storage controls', () => {
    expect(settingsDirContent).toContain("t('skills.storagePathTitle')");
    expect(settingsDirContent).toContain("t('skills.openStoragePath')");
    expect(settingsDirContent).toContain("t('skills.refreshSkills')");
    expect(settingsDirContent).toContain('window.electronAPI.skills.getStoragePath()');
    expect(settingsDirContent).toContain('window.electronAPI.skills.openStoragePath()');
    expect(settingsDirContent).toContain('Promise.allSettled([');
    expect(settingsDirContent).toContain("throw new Error(errors.join(' | '));");
    expect(settingsDirContent).toContain(
      "`${tRef.current('skills.failedToLoad')}: ${err.message}`"
    );
    expect(settingsDirContent).toContain('await loadSkills();');
  });

  it('functional: skills page keeps folder install as a full-width single action', () => {
    expect(skillsContent).toContain("t('skills.installSkillFromFolder')");
    expect(skillsContent).not.toContain("t('skills.browsePlugins')");
    expect(skillsContent).not.toContain('isPluginModalOpen');
    expect(skillsContent).not.toContain('grid-cols-2');
  });
});
