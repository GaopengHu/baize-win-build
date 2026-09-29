import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Skill } from '../types';

/**
 * "/" 斜杠技能选择器的纯展示组件（状态由 useSlashSkillMenu 持有）。
 *
 * 渲染在 textarea 容器（relative）内、bottom-full 向上弹出——
 * 样式对齐 ChatView 模型快切菜单（rounded-xl border shadow-elevated）。
 * 行 = name + description 单行截断 + type 徽标；active 行高亮，
 * activeIndex 变化时 scrollIntoView；鼠标 hover 同步 activeIndex。
 */
export interface SlashSkillMenuProps {
  items: Skill[];
  activeIndex: number;
  onSelect: (item: Skill) => void;
  onActiveChange: (index: number) => void;
}

const TYPE_LABELS: Record<Skill['type'], string> = {
  builtin: 'Built-in',
  mcp: 'MCP',
  custom: 'Custom',
};

export function SlashSkillMenu({
  items,
  activeIndex,
  onSelect,
  onActiveChange,
}: SlashSkillMenuProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t('chat.slashMenu.ariaLabel')}
      className="absolute bottom-full left-0 mb-2 w-72 max-h-64 overflow-y-auto rounded-xl border border-border bg-background shadow-elevated z-50"
    >
      {items.length === 0 ? (
        <div className="px-3 py-2 text-xs text-text-muted">{t('chat.slashMenu.empty')}</div>
      ) : (
        <div className="py-1">
          {items.map((skill, index) => (
            <button
              key={skill.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              // preventDefault 保住 textarea 焦点（mousedown 默认会转移焦点）
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onActiveChange(index)}
              onClick={() => onSelect(skill)}
              className={`w-full text-left px-3 py-1.5 flex items-start gap-2 transition-colors ${
                index === activeIndex ? 'bg-surface-hover' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-text-primary truncate">
                    {skill.name}
                  </span>
                  <span className="shrink-0 px-1.5 py-px rounded-full text-[10px] leading-4 border border-border-subtle text-text-muted">
                    {TYPE_LABELS[skill.type]}
                  </span>
                </span>
                {skill.description && (
                  <span className="block truncate text-xs text-text-muted">
                    {skill.description}
                  </span>
                )}
              </span>
            </button>
          ))}
          <div className="px-3 pt-1 pb-0.5 text-[10px] text-text-muted">
            {t('chat.slashMenu.hint')}
          </div>
        </div>
      )}
    </div>
  );
}
