import { randomBytes } from "node:crypto";
import { hmacHex, secretMatches } from "@/lib/secrets";

// Seller sessions (Phase 6b). After Log in with PayPal, the browser keeps a signed cookie holding
// the account id and an expiry, for 8 hours. The signing key is derived from PAYPAL_CLIENT_SECRET,
// so there is no extra secret to set, and rotating the PayPal secret logs every seller out.
//
// SameSite=Lax, not Strict: the login ends in a redirect chain that starts on paypal.com, and a
// Strict cookie would not be sent on the first page after it. Cross-site POSTs still cannot carry
// it, and every seller API that changes something also requires a JSON body (no CORS allowed).

export const SELLER_COOKIE = "sd_seller";
export const STATE_COOKIE = "sd_oauth";
export const SESSION_MS = 8 * 3_600_000;
/** Time allowed between leaving for PayPal and coming back. */
export const STATE_MS = 10 * 60_000;

export const sessionKey = (paypalClientSecret: string) =>
  hmacHex(paypalClientSecret, "safedeal-seller-session-v1");

const sign = (key: string, accountId: string, exp: number) =>
  hmacHex(key, `seller:${accountId}:${exp}`);

export function sessionValue(key: string, accountId: string, now: Date): string {
  const exp = now.getTime() + SESSION_MS;
  return `${accountId}.${exp}.${sign(key, accountId, exp)}`;
}

/** The account id in a valid, unexpired session cookie, or null. */
export function sessionAccountId(value: string | null | undefined, key: string, now: Date) {
  if (!value || !key) return null;
  const [accountId, expText, mac] = value.split(".");
  const exp = Number(expText);
  if (!/^[0-9a-f-]{36}$/.test(accountId ?? "")) return null;
  if (!Number.isSafeInteger(exp) || exp <= now.getTime() || !mac) return null;
  return secretMatches(mac, sign(key, accountId, exp)) ? accountId : null;
}

/** A fresh value for the OAuth `state` parameter and its cookie. */
export const newState = () => randomBytes(32).toString("base64url");

/** Does PayPal's returned `state` match the one this browser was sent off with? */
export function stateMatches(returned: string | null, cookie: string | null) {
  return Boolean(returned && cookie && secretMatches(returned, cookie));
}

function cookie(name: string, value: string, maxAgeMs: number, secure: boolean, path = "/") {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export const sessionCookie = (value: string, secure: boolean) =>
  cookie(SELLER_COOKIE, value, SESSION_MS, secure);
export const clearedSessionCookie = (secure: boolean) => cookie(SELLER_COOKIE, "", 0, secure);
export const stateCookie = (value: string, secure: boolean) =>
  cookie(STATE_COOKIE, value, STATE_MS, secure, "/api/auth/paypal");
export const clearedStateCookie = (secure: boolean) =>
  cookie(STATE_COOKIE, "", 0, secure, "/api/auth/paypal");
