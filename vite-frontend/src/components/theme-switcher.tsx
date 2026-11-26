import React from 'react';
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from '@heroui/dropdown';
import { FZ_THEMES, FzThemeId, useFzTheme } from '@/components/theme-provider';

interface ThemeSwitcherProps {
  /**
   * segment: 桌面端顶栏 & 登录页右上角三段式秒切按钮
   * dropdown: 移动端顶栏紧凑色点下拉按钮
   * cards: 个人中心三卡直观预览选择网格
   */
  variant?: 'segment' | 'dropdown' | 'cards';
  className?: string;
}

const SwatchDot = ({ swatch, size = 12 }: { swatch: [string, string, string]; size?: number }) => (
  <span
    className="inline-flex items-center justify-center rounded-full flex-shrink-0 border border-black/15 dark:border-white/20"
    style={{
      width: size,
      height: size,
      background: `linear-gradient(135deg, ${swatch[0]} 48%, ${swatch[2]} 52%)`,
    }}
  />
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
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: t.swatch[2], opacity: 0.7 }}
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
            <SwatchDot swatch={themeMeta.swatch} size={13} />
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
              startContent={<SwatchDot swatch={t.swatch} size={14} />}
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
            <SwatchDot swatch={t.swatch} size={10} />
            <span>{t.shortName}</span>
          </button>
        );
      })}
    </div>
  );
};

export default ThemeSwitcher;
