/**
 * 安全退出登录函数
 * 清除登录相关数据，保留用户的视觉偏好设置（如所选主题、侧栏收起状态）
 */
const PRESERVE_KEYS = ['fz_ui_theme', 'fz_sidebar_collapsed'];

export const safeLogout = () => {
  const saved: Record<string, string> = {};
  try {
    for (const key of PRESERVE_KEYS) {
      const val = localStorage.getItem(key);
      if (val !== null) saved[key] = val;
    }
    localStorage.clear();
    for (const [key, val] of Object.entries(saved)) {
      localStorage.setItem(key, val);
    }
  } catch {
    localStorage.clear();
  }
};
