import { describe, expect, it } from "vitest";
import {
  newState,
  SESSION_MS,
  sessionAccountId,
  sessionCookie,
  sessionKey,
  sessionValue,
  stateCookie,
  stateMatches,
} from "./session";

const key = sessionKey("paypal-client-secret");
const id = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const now = new Date("2026-10-25T10:00:00Z");

describe("seller session", () => {
  it("round-trips the account id until it expires", () => {
    const v = sessionValue(key, id, now);
    expect(sessionAccountId(v, key, now)).toBe(id);
    expect(sessionAccountId(v, key, new Date(now.getTime() + SESSION_MS - 1))).toBe(id);
    expect(sessionAccountId(v, key, new Date(now.getTime() + SESSION_MS))).toBeNull();
  });

  it("rejects a forged, altered or foreign cookie", () => {
    const v = sessionValue(key, id, now);
    const [, exp, mac] = v.split(".");
    expect(
      sessionAccountId(`11111111-1d2a-4c3b-9e8f-0a1b2c3d4e5f.${exp}.${mac}`, key, now),
    ).toBeNull();
    expect(sessionAccountId(`${id}.${Number(exp) + 1000}.${mac}`, key, now)).toBeNull();
    expect(sessionAccountId(v, sessionKey("another-secret"), now)).toBeNull();
    expect(sessionAccountId("garbage", key, now)).toBeNull();
    expect(sessionAccountId(undefined, key, now)).toBeNull();
  });

  it("derives a key that is not the PayPal secret itself", () => {
    expect(key).not.toContain("paypal-client-secret");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses HttpOnly, SameSite=Lax cookies; Secure on https; state only for the PayPal routes", () => {
    const c = sessionCookie("v", true);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Secure");
    expect(sessionCookie("v", false)).not.toContain("Secure");
    expect(stateCookie("s", false)).toContain("Path=/api/auth/paypal");
  });

  it("matches the OAuth state exactly, and never when either side is missing", () => {
    const s = newState();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newState()).not.toBe(s);
    expect(stateMatches(s, s)).toBe(true);
    expect(stateMatches(s, newState())).toBe(false);
    expect(stateMatches(null, s)).toBe(false);
    expect(stateMatches(s, null)).toBe(false);
  });
});
