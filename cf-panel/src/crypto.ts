import crypto from "node:crypto";
import { Buffer } from "node:buffer";

export function md5Hex(s: string): string {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

export function sha256Bytes(data: string | Uint8Array): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function hmacSha256(key: string | Uint8Array, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

export function newUUID(): string {
  return crypto.randomUUID();
}

export function simpleUUID(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function newRandomHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

const FINGERPRINT_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function newFingerprint(): string {
  const buf = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += FINGERPRINT_CHARS[buf[i] % FINGERPRINT_CHARS.length];
  }
  return out;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------- AES-256-GCM（与 Go Agent 完全兼容：key=SHA256(secret), base64(iv[12]+ct+tag[16])） ----------

const keyCache = new Map<string, Buffer>();

function aesKeyFor(secret: string): Buffer {
  let k = keyCache.get(secret);
  if (!k) {
    k = sha256Bytes(secret);
    if (keyCache.size > 256) keyCache.clear();
    keyCache.set(secret, k);
  }
  return k;
}

export function aesEncrypt(secret: string, plain: string | Uint8Array): string {
  const key = aesKeyFor(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plainBuf = typeof plain === "string" ? Buffer.from(plain, "utf8") : Buffer.from(plain);
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function aesDecrypt(secret: string, b64: string): string {
  const raw = Buffer.from(b64, "base64");
  if (raw.length < 28) {
    throw new Error("加密数据长度不足");
  }
  const key = aesKeyFor(secret);
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function decryptIfNeeded(rawText: string, secret: string): string {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("{") || !secret) {
    return rawText;
  }
  try {
    const wrap = JSON.parse(trimmed) as { encrypted?: unknown; data?: unknown };
    if (wrap.encrypted === true && typeof wrap.data === "string" && wrap.data.length > 0) {
      return aesDecrypt(secret, wrap.data);
    }
  } catch {
    // 非加密或解密失败时按原文处理，与 Go 版一致
  }
  return rawText;
}

export function encryptForNode(secret: string, plainText: string): string {
  if (!secret) return plainText;
  try {
    const enc = aesEncrypt(secret, plainText);
    return JSON.stringify({ encrypted: true, data: enc, timestamp: Date.now() });
  } catch {
    return plainText;
  }
}

// ---------- JWT（HmacSHA256，有效期 90 天，与 Go/Java 版 100% 兼容） ----------

export interface Claims {
  userId: number;
  roleId: number;
  name: string;
}

function b64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function jwtSign(content: string, jwtSecret: string): string {
  return b64url(hmacSha256(jwtSecret, content));
}

export function generateToken(
  u: { id: number; user: string; roleId: number },
  jwtSecret: string,
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = JSON.stringify({ alg: "HmacSHA256", typ: "JWT" });
  const payload = JSON.stringify({
    sub: String(u.id),
    iat: nowSec,
    exp: nowSec + 90 * 24 * 3600,
    user: u.user,
    name: u.user,
    role_id: u.roleId,
  });
  const content = `${b64url(header)}.${b64url(payload)}`;
  return `${content}.${jwtSign(content, jwtSecret)}`;
}

export function parseToken(token: string, jwtSecret: string): Claims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = jwtSign(`${parts[0]}.${parts[1]}`, jwtSecret);
  if (!timingSafeEqualStr(expected, parts[2])) return null;
  try {
    const raw = Buffer.from(parts[1], "base64url").toString("utf8");
    const p = JSON.parse(raw) as Record<string, unknown>;
    const toInt = (v: unknown): number | null => {
      if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
      if (typeof v === "string" && /^-?\d+$/.test(v)) return parseInt(v, 10);
      return null;
    };
    const exp = toInt(p.exp);
    const sub = toInt(p.sub);
    const role = toInt(p.role_id);
    if (exp === null || sub === null || role === null || exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    const name = typeof p.name === "string" ? p.name : "";
    return { userId: sub, roleId: role, name };
  } catch {
    return null;
  }
}
