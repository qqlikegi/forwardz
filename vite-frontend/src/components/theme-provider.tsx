import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useTheme } from '@heroui/use-theme';

export type FzThemeId = 'obsidian' | 'ceramic' | 'amber';

export interface FzThemeMeta {
  id: FzThemeId;
  name: string;
  shortName: string;
  desc: string;
  isDark: boolean;
  /** [背景色, 卡片色, 强调色] 用于色卡展示 */
  swatch: [string, string, string];
}

export const FZ_THEME_STORAGE_KEY = 'fz_ui_theme';

export const FZ_THEMES: FzThemeMeta[] = [
  {
    id: 'obsidian',
    name: '精密曜石',
    shortName: '曜石',
    desc: '深邃沉静 · 线性高光',
    isDark: true,
    swatch: ['#0a0b0f', '#171b26', '#3b82f6'],
  },
  {
    id: 'ceramic',
    name: '瑞士冷瓷',
    shortName: '冷瓷',
    desc: '温润浅色 · 秩序清爽',
    isDark: false,
    swatch: ['#f6f6f3', '#ffffff', '#2563eb'],
  },
  {
    id: 'amber',
    name: '暗夜琥珀',
    shortName: '琥珀',
    desc: '机房控制台 · 琥珀高亮',
    isDark: true,
    swatch: ['#0d0e11', '#181b22', '#f59e0b'],
  },
];

const isValidTheme = (v: string | null): v is FzThemeId =>
  v === 'obsidian' || v === 'ceramic' || v === 'amber';

const getInitialTheme = (): FzThemeId => {
  if (typeof window === 'undefined') return 'obsidian';
  try {
    const saved = localStorage.getItem(FZ_THEME_STORAGE_KEY);
    if (isValidTheme(saved)) return saved;
  } catch {
    // 忽略读取异常
  }
  const attr = document.documentElement.getAttribute('data-fz-theme');
  if (isValidTheme(attr)) return attr;
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'obsidian' : 'ceramic';
};

interface FzThemeContextValue {
  fzTheme: FzThemeId;
  themeMeta: FzThemeMeta;
  setFzTheme: (id: FzThemeId) => void;
}

const FzThemeContext = createContext<FzThemeContextValue>({
  fzTheme: 'obsidian',
  themeMeta: FZ_THEMES[0],
  setFzTheme: () => {},
});

export const useFzTheme = () => useContext(FzThemeContext);

interface ThemeProviderProps {
  children: React.ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const { setTheme } = useTheme();
  const [fzTheme, setFzThemeState] = useState<FzThemeId>(getInitialTheme);

  const applyThemeToDom = useCallback(
    (id: FzThemeId) => {
      const meta = FZ_THEMES.find((t) => t.id === id) ?? FZ_THEMES[0];
      const root = document.documentElement;
      root.setAttribute('data-fz-theme', meta.id);
      if (meta.isDark) {
        root.classList.add('dark');
        root.style.colorScheme = 'dark';
        setTheme('dark');
      } else {
        root.classList.remove('dark');
        root.style.colorScheme = 'light';
        setTheme('light');
      }
    },
    [setTheme],
  );

  const setFzTheme = useCallback(
    (id: FzThemeId) => {
      setFzThemeState(id);
      try {
        localStorage.setItem(FZ_THEME_STORAGE_KEY, id);
      } catch {
        // 忽略存储异常
      }
      applyThemeToDom(id);
    },
    [applyThemeToDom],
  );

  useEffect(() => {
    applyThemeToDom(fzTheme);
  }, [fzTheme, applyThemeToDom]);

  // 未手动选择过主题时，自动跟随系统日夜模式切换（obsidian <-> ceramic）
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      try {
        if (isValidTheme(localStorage.getItem(FZ_THEME_STORAGE_KEY))) return;
      } catch {
        // ignore
      }
      setFzThemeState(e.matches ? 'obsidian' : 'ceramic');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 多标签页同步主题切换
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === FZ_THEME_STORAGE_KEY && isValidTheme(e.newValue)) {
        setFzThemeState(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const themeMeta = FZ_THEMES.find((t) => t.id === fzTheme) ?? FZ_THEMES[0];

  return (
    <FzThemeContext.Provider value={{ fzTheme, themeMeta, setFzTheme }}>
      {children}
    </FzThemeContext.Provider>
  );
};
