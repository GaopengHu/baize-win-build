import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { parseSlashQuery, filterSkills, buildSkillCommand } from '../utils/slash-menu';
import type { Skill } from '../types';

/**
 * ChatView 输入框的 "/" 斜杠技能选择器 hook。
 *
 * 单一实例服务 welcome / 主聊天两个 textarea（二者共享同一份 prompt state、
 * textareaRef、isComposingRef，且同时只挂载一个）。
 *
 * - 列表来源：`window.electronAPI.skills.getAll()`，仅保留 enabled 技能；
 *   刷新时机 = 挂载时 + closed→open 转变时 + store.skillsStorageChangedAt 变化时
 *   （IPC 失败 try/catch 保留旧列表）。
 * - open 为 prompt 的派生状态（parseSlashQuery）：零匹配也打开，显示 i18n 空态；
 *   提交/清空后 parseSlashQuery('') 失活 → 自动关闭。不做点击外部关闭。
 * - handleKeyDown 返回 true 表示按键已消费（调用方应 return）。
 *   顺序关键：IME 组合中一律不抢键 → !open 放行 → ↑↓ 回绕 →
 *   Enter（无 shift）/Tab 仅在有匹配项时消费（否则落回既有提交逻辑，
 *   未知命令按字面发送，与主进程透传行为一致）→ Escape 关闭。
 */
export interface UseSlashSkillMenuParams {
  prompt: string;
  setPrompt: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  isComposingRef: React.MutableRefObject<boolean>;
}

export interface SlashSkillMenuState {
  open: boolean;
  items: Skill[];
  activeIndex: number;
  /** @returns true = 按键已消费（阻止默认行为并停止后续处理） */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  select: (item: Skill) => void;
  setActiveIndex: (index: number) => void;
  close: () => void;
}

export function useSlashSkillMenu({
  prompt,
  setPrompt,
  textareaRef,
  isComposingRef,
}: UseSlashSkillMenuParams): SlashSkillMenuState {
  const skillsStorageChangedAt = useAppStore((s) => s.skillsStorageChangedAt);

  const [skills, setSkills] = useState<Skill[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // Escape 关闭但保留用户文本（open 由 prompt 派生，dismissed 是唯一的
  // "文本仍激活但菜单收起"状态；query 变化或离开斜杠上下文时自动复位）。
  const [dismissed, setDismissed] = useState(false);

  const { active, query } = parseSlashQuery(prompt);
  const open = active && !dismissed;
  const items = filterSkills(skills, query);

  useEffect(() => {
    setDismissed(false);
  }, [query, active]);

  // ── 列表加载（挂载时 + closed→open 转变 + skillsStorageChangedAt 变化）──
  const wasOpenRef = useRef(false);
  const loadSkills = useCallback(async () => {
    try {
      const all = await window.electronAPI.skills.getAll();
      setSkills(all.filter((s) => s.enabled));
    } catch {
      // IPC 失败保留旧列表——菜单降级但不崩溃
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills, skillsStorageChangedAt]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      void loadSkills();
    }
    wasOpenRef.current = open;
  }, [open, loadSkills]);

  // ── activeIndex 在 query 变化或列表刷新时重置 ──
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);
  useEffect(() => {
    setActiveIndex(0);
  }, [skills]);

  const close = useCallback(() => {
    // 不清除用户文本：Escape 只收起菜单（dismissed），继续输入命令 token
    // （query 变化）会自动重开；提交路径下 prompt 清空 → 派生状态自然关闭。
    setDismissed(true);
  }, []);

  const select = useCallback(
    (item: Skill) => {
      setPrompt(buildSkillCommand(item.name));
      // 受控 textarea 需等重渲染后再置焦点/光标
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        const caret = el.value.length;
        el.setSelectionRange(caret, caret);
      });
    },
    [setPrompt, textareaRef]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      // 1. IME 组合中：一律不抢键（Enter 用于确认组合输入）
      if (e.nativeEvent.isComposing || isComposingRef.current) {
        return false;
      }
      if (!open) {
        return false;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (items.length > 0) {
            setActiveIndex((prev) => (prev + 1) % items.length);
          }
          return true;
        case 'ArrowUp':
          e.preventDefault();
          if (items.length > 0) {
            setActiveIndex((prev) => (prev - 1 + items.length) % items.length);
          }
          return true;
        case 'Enter':
          if (e.shiftKey) return false;
          if (items.length === 0) return false; // 落回提交逻辑，字面发送
          e.preventDefault();
          select(items[activeIndex]);
          return true;
        case 'Tab':
          if (items.length === 0) return false; // 无匹配不劫持 Tab 导航
          e.preventDefault();
          select(items[activeIndex]);
          return true;
        case 'Escape':
          e.preventDefault();
          close();
          return true;
        default:
          return false;
      }
    },
    [open, items, activeIndex, select, close, isComposingRef]
  );

  return { open, items, activeIndex, handleKeyDown, select, setActiveIndex, close };
}
