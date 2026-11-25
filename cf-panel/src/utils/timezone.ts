/**
 * 固定偏移时区工具（默认 UTC+8 / Asia/Shanghai），避免 Workers 默认 UTC 导致跨天/整点统计错位。
 */

const DEFAULT_OFFSET_MIN = 480;

export function parseTzOffsetMinutes(raw?: string): number {
  if (!raw) return DEFAULT_OFFSET_MIN;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_OFFSET_MIN;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 将 UTC 毫秒时间戳转换为“平移后的 Date”，读取 getUTC* 即为目标时区的年月日时分秒 */
function shiftedDate(ms: number, offsetMin: number): Date {
  return new Date(ms + offsetMin * 60_000);
}

/** YYYY-MM-DD */
export function formatLocalDate(ms: number, offsetMin: number): string {
  const d = shiftedDate(ms, offsetMin);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** YYYY-MM */
export function formatLocalMonth(ms: number, offsetMin: number): string {
  const d = shiftedDate(ms, offsetMin);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** HH:00 */
export function formatLocalHour(ms: number, offsetMin: number): string {
  const d = shiftedDate(ms, offsetMin);
  return `${pad2(d.getUTCHours())}:00`;
}

/** YYYYMMDD-HHMMSS */
export function formatLocalCompact(ms: number, offsetMin: number): string {
  const d = shiftedDate(ms, offsetMin);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

/** 返回目标时区当天 00:00:00 对应的 UTC 毫秒时间戳 */
export function localDayStartMs(ms: number, offsetMin: number): number {
  const d = shiftedDate(ms, offsetMin);
  const utcDayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  return utcDayStart - offsetMin * 60_000;
}

/** 返回目标时区当前的 (hour, day, lastDayOfMonth) */
export function localCalendarParts(ms: number, offsetMin: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  lastDay: number;
} {
  const d = shiftedDate(ms, offsetMin);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-based
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { year, month, day, hour, minute, lastDay };
}

/** 给定目标时区 HH:MM 和锚点 UTC 毫秒数，计算下一次运行的 UTC 毫秒时间戳 */
export function nextDailyRunMs(anchorMs: number, hhmm: string, offsetMin: number): number {
  const [hStr, mStr] = hhmm.split(":");
  const hh = parseInt(hStr, 10) || 0;
  const mm = parseInt(mStr, 10) || 0;
  const d = shiftedDate(anchorMs, offsetMin);
  let targetShifted = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, 0, 0);
  const anchorShifted = anchorMs + offsetMin * 60_000;
  if (targetShifted <= anchorShifted) {
    targetShifted += 86_400_000;
  }
  return targetShifted - offsetMin * 60_000;
}
