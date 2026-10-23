import { slidingWindow } from "@/lib/ai/rate-limit";
import { hmacHex, secretMatches } from "@/lib/secrets";

// Admin access (BUILD_PLAN 8.5): one shared password (ADMIN_PASSWORD), then a signed session
// cookie for 8 hours. The cookie holds only an expiry and an HMAC of it keyed by the password, so
// changing the password logs everyone out. SameSite=Strict plus a JSON-only rule for admin POSTs
// keeps other sites from submitting decisions with the admin's cookie.

export const ADMIN_COOKIE = "sd_admin";
export const SESSION_MS = 8 * 3_600_000;

/** Wrong passwords: 5 tries per client per 15 minutes. */
export const loginLimiter = slidingWindow(5, 15 * 60_000);

const sign = (password: string, exp: number) => hmacHex(password, `safedeal-admin:${exp}`);

export function sessionValue(password: string, now: Date): string {
  const exp = now.getTime() + SESSION_MS;
  return `${exp}.${sign(password, exp)}`;
}

export function validSession(value: string | undefined | null, password: string, now: Date) {
  if (!value || !password) return false;
  const [expText, mac] = value.split(".");
  const exp = Number(expText);
  if (!Number.isSafeInteger(exp) || exp <= now.getTime() || !mac) return false;
  return secretMatches(mac, sign(password, exp));
}

export function cookieFrom(header: string | null, name = ADMIN_COOKIE): string | null {
  for (const part of header?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionCookie(value: string, secure: boolean): string {
  return [
    `${ADMIN_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_MS / 1000}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export const clearedCookie = `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
