import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// 全面安装制：设置侧栏只有统一「技能」页（SettingsSkills.tsx，双视图）。
// 市场视图组件为 MarketplaceBrowser.tsx；'marketplace' 保留为导航别名
// （深链落到 skills tab 并自动切市场视图），旧 SettingsMarketplace.tsx 已删除。
const root = process.cwd();
const settingsPanelPath = path.resolve(root, 'src/renderer/components/SettingsPanel.tsx');
const settingsDir = path.resolve(root, 'src/renderer/components/settings');
const marketplaceBrowserPath = path.join(settingsDir, 'MarketplaceBrowser.tsx');
const skillsPath = path.join(settingsDir, 'SettingsSkills.tsx');
const settingsPanelContent = readFileSync(settingsPanelPath, 'utf8');
const settingsDirContent = readdirSync(settingsDir)
  .map((f) => readFileSync(path.join(settingsDir, f), 'utf8'))
  .join('\n');
const marketplaceContent = existsSync(marketplaceBrowserPath)
  ? readFileSync(marketplaceBrowserPath, 'utf8')
  : '';
const skillsContent = existsSync(skillsPath) ? readFileSync(skillsPath, 'utf8') : '';

describe('SettingsPanel unified skills page', () => {
  it('has no peer-level marketplace tab; keeps marketplace as a navigation alias', () => {
    // 侧栏不再注册 marketplace tab，也不引用已删除的 SettingsMarketplace
    expect(settingsPanelContent).not.toContain('SettingsMarketplace');
    expect(settingsPanelContent).not.toContain("t('settings.marketplace')");
    // 'marketplace' 仍保留在 TabId/VALID_TABS 作为深链别名 → normalizeTab 映射到 skills+market
    expect(settingsPanelContent).toContain("'marketplace'");
    expect(settingsPanelContent).toContain('normalizeTab');
    expect(settingsPanelContent).toContain("skillsView: 'market'");
    expect(settingsPanelContent).toContain('<SettingsSkills');
    expect(settingsPanelContent).toContain('initialView={skillsView}');
  });

  it('old SettingsMarketplace.tsx is removed', () => {
    expect(existsSync(path.join(settingsDir, 'SettingsMarketplace.tsx'))).toBe(false);
  });

  it('unit: unified skills page renders both views', () => {
    expect(skillsContent).toContain("t('skills.viewInstalled')");
    expect(skillsContent).toContain("t('skills.viewMarket')");
    expect(skillsContent).toContain('<MarketplaceBrowser');
    expect(skillsContent).toContain("t('skills.installedSkills')");
    expect(skillsContent).toContain("t('skills.noInstalledSkills')");
  });

  it('unit: marketplace browser renders list page content and install-state machine', () => {
    expect(marketplaceContent).toContain("t('skills.marketplaceTitle')");
    expect(marketplaceContent).toContain("t('skills.marketplaceEmpty')");
    expect(marketplaceContent).toContain("t('skills.marketplaceInstall')");
    // 已安装态：installed 徽标 / update 动作 / needsUpdate 版本比较
    expect(marketplaceContent).toContain("t('skills.installedBadge')");
    expect(marketplaceContent).toContain("t('skills.updateAction')");
    expect(marketplaceContent).toContain('needsUpdate');
    // 更新按钮必须可点击（重装覆盖），仅「已安装且版本一致」才禁用
    expect(marketplaceContent).toContain('(isInstalled && !needsUpdate)');
  });

  it('functional: uses marketplace IPC API for catalog, install and rating', () => {
    expect(marketplaceContent).toContain('window.electronAPI.marketplace.listSkillApps');
    expect(marketplaceContent).toContain('window.electronAPI.marketplace.installSkill');
    expect(marketplaceContent).toContain('window.electronAPI.marketplace.submitRating');
    expect(marketplaceContent).toContain('window.electronAPI.marketplace.getIcon');
  });

  it('functional: marketplace install notifies parent to refresh installed list', () => {
    // 统一页内：安装成功 → loadInstalledSkills + onInstalled 回调刷新已安装视图；
    // 同时保留主进程 watcher 广播（skills.storageChanged）作为兜底。
    expect(marketplaceContent).toContain('onInstalled?.()');
    expect(marketplaceContent).toContain('skills.getAll');
    expect(skillsContent).toContain('handleInstalledFromMarket');
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

  it('functional: folder install lives in the top header, not the bottom section', () => {
    expect(skillsContent).toContain("t('skills.installSkillFromFolder')");
    expect(skillsContent).not.toContain("t('skills.browsePlugins')");
    expect(skillsContent).not.toContain('isPluginModalOpen');
    // 底部「插件与导入」section 已删除（按钮前置到页面 header，市场/已安装两视图均可见）
    expect(skillsContent).not.toContain("t('skills.pluginsTitle')");
    // 顶部 header 按钮与文件夹选择流程
    expect(skillsContent).toContain("type: 'folder.select'");
    expect(skillsContent).toContain('handleInstall');
  });

  it('functional: installed list uses marketplace-style responsive grid', () => {
    expect(skillsContent).toContain('sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4');
    // 市场视图同款网格
    expect(marketplaceContent).toContain('sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4');
  });

  it('functional: both views navigate to a metadata detail page', () => {
    // 已安装侧：detailSkillId state + ChevronLeft 返回行
    expect(skillsContent).toContain('detailSkillId');
    expect(skillsContent).toContain('ChevronLeft');
    expect(skillsContent).toContain("t('skills.backToList')");
    // 市场侧：detailAppId state + 返回市场行；卡片整卡可点击进详情
    expect(marketplaceContent).toContain('detailAppId');
    expect(marketplaceContent).toContain('ChevronLeft');
    expect(marketplaceContent).toContain("t('skills.backToMarket')");
    expect(marketplaceContent).toContain('onClick={() => setDetailAppId(app.appId)}');
    // 详情页含安装包列表与描述（仅元数据，无新 IPC）
    expect(marketplaceContent).toContain("t('skills.detailPackages')");
    expect(marketplaceContent).toContain("t('skills.detailDescription')");
    expect(marketplaceContent).not.toContain('skills.getDetail');
  });

  it('functional: skills page defaults to the marketplace view', () => {
    // normalizeTab 恒返回 market 视图；侧栏点击技能 tab 也回市场首页
    expect(settingsPanelContent).toContain("skillsView: 'market'");
    expect(settingsPanelContent).toContain("setSkillsView('market')");
    expect(skillsContent).toContain("initialView = 'market'");
  });

  it('functional: installed cards expose source badge, version and uninstall', () => {
    expect(skillsContent).toContain("t('skills.sourceMarketplace')");
    expect(skillsContent).toContain("t('skills.sourceLocal')");
    expect(skillsContent).toContain("t('skills.versionLabel'");
    expect(skillsContent).toContain("t('skills.uninstall')");
    expect(skillsContent).toContain("t('skills.uninstallConfirm'");
    // 不再区分内置/自定义
    expect(skillsContent).not.toContain("t('skills.builtinSkills')");
    expect(skillsContent).not.toContain("t('skills.customSkills')");
  });

  it('functional: installed cards load marketplace icons with a Package fallback', () => {
    // 已安装视图复用市场图标 IPC（按 appId 懒加载），失败/缺失回落 Package 图标
    expect(skillsContent).toContain('window.electronAPI?.marketplace');
    expect(skillsContent).toContain('.getIcon(appId)');
    expect(skillsContent).toContain('installedIconCache');
    // 卡片图标 44px（w-11），详情页图标 56px（w-14）
    expect(skillsContent).toContain('w-11 h-11 rounded-lg object-cover');
    expect(skillsContent).toContain('w-14 h-14 rounded-lg object-cover');
    // 无图标时回落默认 Package 图标
    expect(skillsContent).toContain('<Package className="w-5 h-5 text-text-muted" />');
    expect(skillsContent).toContain('<Package className="w-7 h-7 text-text-muted" />');
  });

  it('functional: installed view supports search and shared category chips', () => {
    // 分类常量从市场视图导出复用，保证两处口径一致
    expect(marketplaceContent).toContain('export const MARKETPLACE_CATEGORIES');
    expect(skillsContent).toContain('MARKETPLACE_CATEGORIES');
    expect(skillsContent).toContain('import { MARKETPLACE_CATEGORIES, MarketplaceBrowser }');
    // 搜索框 + 分类 chip（含「全部」）+ 无匹配回退
    expect(skillsContent).toContain("t('skills.marketplaceSearchPlaceholder')");
    expect(skillsContent).toContain("t('skills.marketplaceAllCategory')");
    expect(skillsContent).toContain("t('skills.marketplaceNoMatch')");
    // 已安装技能按 appId/name join 市场目录取 tags
    expect(skillsContent).toContain('marketplaceApps');
    expect(skillsContent).toContain('installedSkillMeta');
    expect(skillsContent).toContain('filteredInstalledSkills');
  });

  it('functional: installed view supports batch manage via existing skills IPC', () => {
    expect(skillsContent).toContain('batchMode');
    expect(skillsContent).toContain('selectedSkillIds');
    expect(skillsContent).toContain('toggleSelectAllVisible');
    // 批量启停/卸载复用现有单条 IPC（无新 IPC）
    expect(skillsContent).toContain('skills.setEnabled(skill.id, enable)');
    expect(skillsContent).toContain('skills.delete(skill.id)');
    expect(skillsContent).toContain("t('skills.batchManage')");
    expect(skillsContent).toContain("t('skills.batchEnable')");
    expect(skillsContent).toContain("t('skills.batchDisable')");
    expect(skillsContent).toContain("t('skills.batchUninstall')");
    expect(skillsContent).toContain("t('skills.batchUninstallConfirm'");
  });

  it('functional: installed section drops installSkillsDesc and localizes invalid folder', () => {
    // 已安装 section 描述已移除，不再引用 installSkillsDesc（key 同步删除）
    expect(skillsContent).not.toContain('installSkillsDesc');
    // 文件夹校验失败改为 i18n 文案，不再硬编码英文
    expect(skillsContent).not.toContain('Invalid skill folder');
    expect(skillsContent).toContain("t('skills.invalidSkillFolder'");
  });
});
