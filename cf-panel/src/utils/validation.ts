export const BYTES_PER_GB = 1024 * 1024 * 1024;

export interface R<T = unknown> {
  code: number;
  msg: string;
  ts: number;
  data: T;
}

export function ok<T = unknown>(data?: T): R<T | null> {
  return {
    code: 0,
    msg: "操作成功",
    ts: Date.now(),
    data: data === undefined ? null : data,
  };
}

export function fail(msg: string): R<null> {
  return { code: -1, msg, ts: Date.now(), data: null };
}

export function failCode(code: number, msg: string): R<null> {
  return { code, msg, ts: Date.now(), data: null };
}

export class BizError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BizError";
  }
}

export class ValidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidError";
  }
}

export function throwBiz(msg: string): never {
  throw new BizError(msg);
}

export function throwValid(msg: string): never {
  throw new ValidError(msg);
}

// ---------- 宽松 JSON 数字/字符串解析（兼容 1 / "1" / null / ""） ----------

export interface ParsedNum {
  valid: boolean;
  v: number;
}

export function parseNum(raw: unknown): ParsedNum {
  if (raw === undefined || raw === null) {
    return { valid: false, v: 0 };
  }
  if (typeof raw === "boolean") {
    throwBiz(`不是数字: ${String(raw)}`);
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throwBiz(`不是数字: ${String(raw)}`);
    }
    return { valid: true, v: raw };
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "") {
      return { valid: false, v: 0 };
    }
    if (s === "true" || s === "false") {
      throwBiz(`不是数字: ${s}`);
    }
    const v = Number(s);
    if (!Number.isFinite(v)) {
      throwBiz(`不是数字: ${s}`);
    }
    return { valid: true, v };
  }
  throwBiz(`不是数字: ${String(raw)}`);
}

export function numInt(n: ParsedNum): number {
  return Math.trunc(n.v);
}

export function numPtr(n: ParsedNum): number | null {
  return n.valid ? Math.trunc(n.v) : null;
}

export interface ParsedStr {
  valid: boolean;
  v: string;
}

export function parseStr(raw: unknown): ParsedStr {
  if (raw === undefined || raw === null) {
    return { valid: false, v: "" };
  }
  if (typeof raw === "string") {
    return { valid: true, v: raw };
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return { valid: true, v: String(raw) };
  }
  return { valid: true, v: JSON.stringify(raw) };
}

export function strBlank(s: ParsedStr): boolean {
  return !s.valid || s.v.trim() === "";
}

export function strPtr(s: ParsedStr): string | null {
  return s.valid ? s.v : null;
}

export function notBlank(s: ParsedStr, msg: string): void {
  if (strBlank(s)) {
    throwValid(msg);
  }
}

export function notNull(n: ParsedNum, msg: string): void {
  if (!n.valid) {
    throwValid(msg);
  }
}

export function minVal(n: ParsedNum, min: number, msg: string): void {
  if (n.valid && n.v < min) {
    throwValid(msg);
  }
}

export function validRatio(n: ParsedNum): void {
  if (n.valid && (n.v <= 0 || n.v > 100)) {
    if (n.v <= 0) {
      throwValid("流量倍率必须大于0.0");
    }
    throwValid("流量倍率不能大于100.0");
  }
}

export function paramStr(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (v === undefined || v === null) {
    throwBiz(`参数 ${key} 不能为空`);
  }
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function paramInt(p: Record<string, unknown>, key: string): number {
  const s = paramStr(p, key).trim();
  if (!/^-?\d+$/.test(s)) {
    throwBiz(`参数 ${key} 格式错误`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n)) {
    throwBiz(`参数 ${key} 格式错误`);
  }
  return n;
}

// ---------- 网络地址与端口范围工具 ----------

export function isIPv6(s: string): boolean {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ":") count++;
  }
  return count >= 2;
}

/**
 * IPv6 地址加方括号；若已包含 http:// / https:// / ws:// / wss:// 协议前缀则原样返回（去掉尾部斜杠）
 */
export function processServerAddress(addr: string): string {
  const trimmed = addr.trim();
  if (trimmed === "") return addr;
  if (/^(https?|wss?):\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  if (trimmed.startsWith("[")) {
    return trimmed;
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) {
    return isIPv6(trimmed) ? `[${trimmed}]` : trimmed;
  }
  const host = trimmed.slice(0, idx);
  const port = trimmed.slice(idx);
  if (isIPv6(host)) {
    return `[${host}]${port}`;
  }
  return trimmed;
}

const PORT_PART_RE = /^([0-9]{1,5})(-([0-9]{1,5}))?$/;

export function validatePortRange(port: string): void {
  if (!port) {
    throwBiz("可用端口不合法");
  }
  for (const rawPart of port.split(",")) {
    const part = rawPart.trim();
    const m = PORT_PART_RE.exec(part);
    if (!m) {
      throwBiz("可用端口不合法");
    }
    const start = parseInt(m[1], 10);
    if (m[3] !== undefined && m[3] !== "") {
      const end = parseInt(m[3], 10);
      if (end > 65535 || start > end) {
        throwBiz("可用端口不合法");
      }
    } else if (start > 65535) {
      throwBiz("可用端口不合法");
    }
  }
}

export function parsePorts(input: string): number[] {
  const set = new Set<number>();
  for (const rawPart of input.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.includes("-")) {
      const [sStr, eStr] = part.split("-", 2);
      const start = parseInt(sStr.trim(), 10);
      const end = parseInt(eStr.trim(), 10);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      for (let i = start; i <= end; i++) {
        set.add(i);
      }
    } else {
      const p = parseInt(part, 10);
      if (!Number.isNaN(p)) {
        set.add(p);
      }
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

export function splitHostPort(addr: string): [string, number] {
  const s = addr.trim();
  if (!s) return ["", -1];
  let host = s;
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end > 1) {
      host = s.slice(1, end);
      if (end + 1 < s.length && s[end + 1] === ":") {
        const p = parseInt(s.slice(end + 2), 10);
        return Number.isNaN(p) ? [host, -1] : [host, p];
      }
    }
  }
  const idx = s.lastIndexOf(":");
  if (idx <= 0) return [host, -1];
  if (!s.startsWith("[")) {
    host = s.slice(0, idx);
  }
  const p = parseInt(s.slice(idx + 1), 10);
  return Number.isNaN(p) ? [host, -1] : [host, p];
}

/** Mbps -> MB/s，保留 1 位小数（四舍五入），与 Go/Java 版输出一致 */
export function speedToMBps(speed: number): string {
  const tenths = Math.floor((20 * speed + 8) / 16);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}
