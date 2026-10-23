import { describe, expect, it } from "vitest";
import { cookieFrom, SESSION_MS, sessionCookie, sessionValue, validSession } from "./auth";

const NOW = new Date("2026-11-03T10:00:00Z");

describe("admin session", () => {
  it("is valid until it expires, and only for the same password", () => {
    const v = sessionValue("pw-one", NOW);
    expect(validSession(v, "pw-one", NOW)).toBe(true);
    expect(validSession(v, "pw-two", NOW)).toBe(false);
    expect(validSession(v, "pw-one", new Date(NOW.getTime() + SESSION_MS + 1))).toBe(false);
  });

  it("rejects forged or empty values, and an unset password", () => {
    const [exp] = sessionValue("pw", NOW).split(".");
    for (const bad of ["", "x", `${exp}.`, `${Number(exp) + 9e9}.${"0".repeat(64)}`]) {
      expect(validSession(bad, "pw", NOW)).toBe(false);
    }
    expect(validSession(sessionValue("", NOW), "", NOW)).toBe(false);
  });

  it("reads the cookie from a header and writes a strict, http-only one", () => {
    expect(cookieFrom("a=1; sd_admin=abc.def; b=2")).toBe("abc.def");
    expect(cookieFrom(null)).toBeNull();
    const c = sessionCookie("v", true);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Secure");
  });
});
