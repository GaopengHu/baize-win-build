import { useState, useEffect } from 'react';
import {
  X,
  Settings,
  Plug,
  Shield,
  Package,
  Clock3,
  Wifi,
  AlertCircle,
  Globe,
  ChevronRight,
  BrainCircuit,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWindowSize } from '../hooks/useWindowSize';
import { RemoteControlPanel } from './RemoteControlPanel';
import { useAppStore } from '../store';
import { SettingsAPI } from './settings/SettingsAPI';
import { SettingsSandbox } from './settings/SettingsSandbox';
import { SettingsConnectors } from './settings/SettingsConnectors';
import { SettingsSkills } from './settings/SettingsSkills';
import { SettingsSchedule } from './settings/SettingsSchedule';
import { SettingsGeneral } from './settings/SettingsGeneral';
import { SettingsLogs } from './settings/SettingsLogs';
import { SettingsMemory } from './settings/SettingsMemory';

interface SettingsPanelProps {
  onClose: () => void;
  initialTab?:
    | 'api'
    | 'sandbox'
    | 'connectors'
    | 'skills'
    | 'marketplace'
    | 'memory'
    | 'schedule'
    | 'remote'
    | 'logs'
    | 'general';
}

type TabId =
  | 'api'
  | 'sandbox'
  | 'connectors'
  | 'skills'
  | 'marketplace'
  | 'memory'
  | 'schedule'
  | 'remote'
  | 'logs'
  | 'general';

// Tabs kept functional but hidden from the settings sidebar.
// They remain reachable programmatically (e.g. via nav-server __navigate).
const HIDDEN_TABS = new Set<TabId>(['remote']);

const VALID_TABS = new Set<TabId>([
  'api',
  'sandbox',
  'connectors',
  'skills',
  'marketplace',
  'memory',
  'schedule',
  'remote',
  'logs',
  'general',
]);

/**
 * 'marketplace' 不再是独立 tab，而是统一「技能」页的导航别名。
 * 技能页默认首页 = 技能市场（用户决策）：所有落到 skills tab 的入口
 * （侧栏点击 / 深链 ?tab=marketplace / store.settingsTab / initialTab）
 * 初始视图一律为 market。nav-server 的 VALID_TABS 不动。
 */
function normalizeTab(tab: TabId): { tab: TabId; skillsView: 'installed' | 'market' } {
  // 'marketplace' 别名归一到 skills tab；技能页默认视图恒为市场首页
  return { tab: tab === 'marketplace' ? 'skills' : tab, skillsView: 'market' };
}

export function SettingsPanel({ onClose, initialTab = 'api' }: SettingsPanelProps) {
  const { t } = useTranslation();
  const { width } = useWindowSize();
  const compactSidebar = width < 900;
  // Read settingsTab from store at mount time so external navigation (nav-server)
  // takes effect even before this component mounts.
  const storeTab = useAppStore((s) => s.settingsTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const resolvedInitial =
    storeTab && VALID_TABS.has(storeTab as TabId) ? (storeTab as TabId) : initialTab;
  const normalizedInitial = normalizeTab(resolvedInitial);

  const [activeTab, setActiveTab] = useState<TabId>(normalizedInitial.tab);
  // 统一技能页视图（'marketplace' 别名进入时 = market）
  const [skillsView, setSkillsView] = useState<'installed' | 'market'>(
    normalizedInitial.skillsView
  );
  // Track which tabs have been viewed at least once (for lazy loading)
  const [viewedTabs, setViewedTabs] = useState<Set<TabId>>(new Set([normalizedInitial.tab]));

  // Consume the store signal and apply tab in one effect
  useEffect(() => {
    if (storeTab && VALID_TABS.has(storeTab as TabId)) {
      const normalized = normalizeTab(storeTab as TabId);
      setActiveTab(normalized.tab);
      setSkillsView(normalized.skillsView);
      setSettingsTab(null);
    }
  }, [storeTab, setSettingsTab]);

  // Mark tab as viewed when it becomes active
  useEffect(() => {
    if (!viewedTabs.has(activeTab)) {
      setViewedTabs((prev) => new Set([...prev, activeTab]));
    }
  }, [activeTab]);

  const tabs = [
    {
      id: 'api' as TabId,
      label: t('settings.apiSettings'),
      icon: Settings,
      description: t('settings.apiSettingsDesc'),
    },
    {
      id: 'sandbox' as TabId,
      label: t('settings.sandbox'),
      icon: Shield,
      description: t('settings.sandboxDesc'),
    },
    {
      id: 'connectors' as TabId,
      label: t('settings.connectors'),
      icon: Plug,
      description: t('settings.connectorsDesc'),
    },
    {
      id: 'skills' as TabId,
      label: t('settings.skills'),
      icon: Package,
      description: t('settings.skillsDesc'),
    },
    {
      id: 'memory' as TabId,
      label: t('settings.memory'),
      icon: BrainCircuit,
      description: t('settings.memoryDesc'),
    },
    {
      id: 'schedule' as TabId,
      label: t('settings.schedule'),
      icon: Clock3,
      description: t('settings.scheduleDesc'),
    },
    {
      id: 'remote' as TabId,
      label: t('settings.remote', '远程控制'),
      icon: Wifi,
      description: t('settings.remoteDesc', '通过飞书等平台远程使用'),
    },
    {
      id: 'logs' as TabId,
      label: t('settings.logs'),
      icon: AlertCircle,
      description: t('settings.logsDesc'),
    },
    {
      id: 'general' as TabId,
      label: t('settings.general'),
      icon: Globe,
      description: t('settings.generalDesc'),
    },
  ];
  const visibleTabs = tabs.filter((tab) => !HIDDEN_TABS.has(tab.id));
  const activeTabMeta = tabs.find((tab) => tab.id === activeTab);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* Sidebar */}
      <div
        className={`${compactSidebar ? 'w-14' : 'w-52 lg:w-60'} bg-background-secondary/88 border-r border-border-muted flex flex-col flex-shrink-0`}
      >
        {!compactSidebar && (
          <div className="px-4 pt-5 pb-4 border-b border-border-muted">
            <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
              {t('settings.title')}
            </p>
            <h2 className="mt-1 text-[1.24rem] font-semibold tracking-[-0.03em] text-text-primary">
              今点通
            </h2>
            <p className="mt-1 text-[11px] leading-4 text-text-muted">{t('settings.panelDesc')}</p>
          </div>
        )}
        <div className={`flex-1 ${compactSidebar ? 'p-1.5 space-y-1' : 'p-3 space-y-1.5'}`}>
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                // 侧栏点击技能 tab 回到市场首页（技能页默认视图 = market）
                if (tab.id === 'skills') {
                  setSkillsView('market');
                }
              }}
              title={compactSidebar ? tab.label : undefined}
              className={`w-full flex items-center ${compactSidebar ? 'justify-center p-2.5' : 'gap-3 px-3.5 py-3'} rounded-lg text-left transition-colors active:scale-[0.98] ${
                activeTab === tab.id
                  ? 'bg-accent/10 text-text-primary font-medium border-l-2 border-accent'
                  : 'hover:bg-surface-hover text-text-secondary hover:text-text-primary'
              }`}
            >
              <tab.icon className="w-4.5 h-4.5 flex-shrink-0" />
              {!compactSidebar && (
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{tab.label}</p>
                  <p className="text-[11px] leading-4 text-text-muted line-clamp-2 mt-0.5">
                    {tab.description}
                  </p>
                </div>
              )}
              {!compactSidebar && activeTab === tab.id && (
                <ChevronRight className="w-4 h-4 flex-shrink-0" />
              )}
            </button>
          ))}
        </div>
        <div className={`${compactSidebar ? 'p-1.5' : 'p-4'} border-t border-border-muted`}>
          <button
            onClick={onClose}
            className={`w-full py-2 ${compactSidebar ? 'px-2' : 'px-4'} rounded-lg bg-background hover:bg-background transition-colors text-text-secondary text-sm`}
            title={compactSidebar ? t('common.close') : undefined}
          >
            {compactSidebar ? <X className="w-4 h-4 mx-auto" /> : t('common.close')}
          </button>
          {!compactSidebar && (
            <p className="text-[10px] text-text-muted text-center mt-2 select-text">v0.0.1</p>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div className="flex items-center justify-between px-4 lg:px-8 py-4 border-b border-border-muted flex-shrink-0 bg-background/88 backdrop-blur-sm">
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-text-muted">
              {t('settings.title')}
            </p>
            <h3 className="mt-1 text-[1.15rem] font-semibold tracking-[-0.02em] text-text-primary">
              {activeTabMeta?.label}
            </h3>
            {activeTabMeta?.description && (
              <p className="mt-1 text-sm text-text-muted max-w-[36rem]">
                {activeTabMeta.description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-surface-hover transition-colors"
          >
            <X className="w-5 h-5 text-text-secondary" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 lg:px-8 lg:py-8">
          <div className="max-w-[860px] w-full min-w-0 mx-auto">
            <div className="">
              <div className={activeTab === 'api' ? '' : 'hidden'}>
                {viewedTabs.has('api') && (
                  <>
                    <SettingsAPI />
                  </>
                )}
              </div>
              <div className={activeTab === 'sandbox' ? '' : 'hidden'}>
                {viewedTabs.has('sandbox') && <SettingsSandbox />}
              </div>
              <div className={activeTab === 'connectors' ? '' : 'hidden'}>
                {viewedTabs.has('connectors') && (
                  <SettingsConnectors isActive={activeTab === 'connectors'} />
                )}
              </div>
              <div className={activeTab === 'skills' ? '' : 'hidden'}>
                {viewedTabs.has('skills') && (
                  <SettingsSkills isActive={activeTab === 'skills'} initialView={skillsView} />
                )}
              </div>
              <div className={activeTab === 'memory' ? '' : 'hidden'}>
                {viewedTabs.has('memory') && <SettingsMemory />}
              </div>
              <div className={activeTab === 'schedule' ? '' : 'hidden'}>
                {viewedTabs.has('schedule') && (
                  <SettingsSchedule isActive={activeTab === 'schedule'} />
                )}
              </div>
              <div className={activeTab === 'remote' ? '' : 'hidden'}>
                {viewedTabs.has('remote') && (
                  <RemoteControlPanel isActive={activeTab === 'remote'} />
                )}
              </div>
              <div className={activeTab === 'logs' ? '' : 'hidden'}>
                {viewedTabs.has('logs') && <SettingsLogs isActive={activeTab === 'logs'} />}
              </div>
              <div className={activeTab === 'general' ? '' : 'hidden'}>
                {viewedTabs.has('general') && <SettingsGeneral />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
