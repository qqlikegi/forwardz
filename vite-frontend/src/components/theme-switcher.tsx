import React from 'react';
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from '@heroui/dropdown';
import { FZ_THEMES, FzThemeId, FzThemeMeta, useFzTheme } from '@/components/theme-provider';

interface ThemeSwitcherProps {
  /**
   * segment: 桌面端顶栏三段式秒切按钮
   * dropdown: 移动端顶栏紧凑图标下拉按钮
   * cards: 个人中心三卡直观预览选择网格
   */
  variant?: 'segment' | 'dropdown' | 'cards';
  className?: string;
}

/** 清晰矢量图标（避免微小双色渐变圆点在移动端产生“图标破损”观感） */
const ThemeGlyph = ({ id, size = 14, color }: { id: FzThemeId; size?: number; color?: string }) => {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color || 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'flex-shrink-0',
  };

  if (id === 'ceramic') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56" />
      </svg>
    );
  }
  if (id === 'amber') {
    return (
      <svg {...common}>
        <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
    </svg>
  );
};

/** 下拉菜单项左侧与卡片一致的圆角矩形纯色图标徽章 */
const ThemeBadgeIcon = ({ theme }: { theme: FzThemeMeta }) => (
  <span
    className="w-7 h-7 inline-flex items-center justify-center flex-shrink-0 border"
    style={{
      borderRadius: 'var(--fz-r-cell)',
      backgroundColor: theme.swatch[0],
      borderColor: theme.isDark ? 'rgba(255,255,255,0.14)' : 'rgba(24,24,27,0.12)',
    }}
  >
    <ThemeGlyph id={theme.id} size={14} color={theme.swatch[2]} />
  </span>
);

export const ThemeSwitcher: React.FC<ThemeSwitcherProps> = ({
  variant = 'segment',
  className = '',
}) => {
  const { fzTheme, themeMeta, setFzTheme } = useFzTheme();

  if (variant === 'cards') {
    return (
      <div className={`grid grid-cols-3 gap-2.5 ${className}`}>
        {FZ_THEMES.map((t) => {
          const active = t.id === fzTheme;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setFzTheme(t.id)}
              className="group relative flex flex-col items-start text-left p-2.5 transition-all cursor-pointer"
              style={{
                borderRadius: 'var(--fz-r-cell)',
                background: active ? 'var(--fz-accent-soft)' : 'var(--fz-fill-2)',
                boxShadow: active
                  ? 'inset 0 0 0 1.5px var(--fz-accent)'
                  : 'inset 0 0 0 1px var(--fz-hairline)',
              }}
            >
              {/* 迷你色块预览 */}
              <div
                className="w-full h-11 rounded-md p-1.5 flex flex-col justify-between mb-2 border overflow-hidden"
                style={{
                  backgroundColor: t.swatch[0],
                  borderColor: t.isDark ? 'rgba(255,255,255,0.12)' : 'rgba(24,24,27,0.1)',
                }}
              >
                <div className="flex items-center justify-between">
                  <span
                    className="w-5 h-1.5 rounded-full"
                    style={{ backgroundColor: t.swatch[2] }}
                  />
                  <span
                    className="w-2 h-2 rounded-sm"
                    style={{ backgroundColor: t.swatch[2], opacity: 0.75 }}
                  />
                </div>
                <div className="flex gap-1">
                  <span
                    className="flex-1 h-4 rounded-sm"
                    style={{ backgroundColor: t.swatch[1] }}
                  />
                  <span
                    className="flex-1 h-4 rounded-sm"
                    style={{ backgroundColor: t.swatch[1] }}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between w-full gap-1">
                <span className="text-xs font-semibold text-foreground truncate">{t.name}</span>
                {active && (
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: 'var(--fz-accent)' }}
                  />
                )}
              </div>
              <span className="text-[10.5px] text-default-500 mt-0.5 truncate w-full">
                {t.desc}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  if (variant === 'dropdown') {
    return (
      <Dropdown placement="bottom-end">
        <DropdownTrigger>
          <button
            type="button"
            aria-label="切换界面主题"
            title={`当前主题：${themeMeta.name}`}
            className={`fz-theme-trigger inline-flex items-center gap-1.5 h-8 px-2.5 text-xs font-medium text-foreground outline-none transition-colors cursor-pointer ${className}`}
          >
            <ThemeGlyph id={themeMeta.id} size={14} color={themeMeta.swatch[2]} />
            <span>{themeMeta.shortName}</span>
            <svg
              className="w-3.5 h-3.5 text-default-500"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </DropdownTrigger>
        <DropdownMenu
          aria-label="选择外观主题"
          selectedKeys={new Set([fzTheme])}
          selectionMode="single"
          onAction={(key) => setFzTheme(String(key) as FzThemeId)}
        >
          {FZ_THEMES.map((t) => (
            <DropdownItem
              key={t.id}
              description={t.desc}
              startContent={<ThemeBadgeIcon theme={t} />}
            >
              {t.name}
            </DropdownItem>
          ))}
        </DropdownMenu>
      </Dropdown>
    );
  }

  // variant === 'segment'
  return (
    <div
      role="radiogroup"
      aria-label="切换界面主题"
      className={`fz-theme-segment inline-flex items-center p-[3px] gap-0.5 ${className}`}
    >
      {FZ_THEMES.map((t) => {
        const active = t.id === fzTheme;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={`${t.name} · ${t.desc}`}
            data-active={active}
            onClick={() => setFzTheme(t.id)}
            className="fz-theme-seg-btn inline-flex items-center gap-1.5 px-2.5 h-7 text-xs font-medium transition-all cursor-pointer"
          >
            <ThemeGlyph id={t.id} size={13} color={t.swatch[2]} />
            <span>{t.shortName}</span>
          </button>
        );
      })}
    </div>
  );
};

export default ThemeSwitcher;
