import { describe, expect, it } from "vitest";
import { codeMatches, handoverCode, handoverHash, normaliseCode } from "./handover";

const DEAL = "6f1d2c3b-0000-4000-8000-000000000001";
const SECRET = "a-test-secret-that-is-long-enough";

describe("handover code", () => {
  it("is 6 digits and the same on every visit", () => {
    const code = handoverCode(DEAL, SECRET);
    expect(code).toMatch(/^\d{6}$/);
    expect(handoverCode(DEAL, SECRET)).toBe(code);
  });

  it("differs between deals and between secrets", () => {
    const codes = new Set(
      Array.from({ length: 50 }, (_, i) => handoverCode(`${DEAL.slice(0, -2)}${i + 10}`, SECRET)),
    );
    expect(codes.size).toBeGreaterThan(45);
    expect(handoverCode(DEAL, "another-secret")).not.toBe(handoverCode(DEAL, SECRET));
  });

  it("refuses to derive a code without a secret", () => {
    expect(() => handoverCode(DEAL, "")).toThrow("HANDOVER_SECRET");
  });

  it("matches only the right code, allowing spaces and dashes", () => {
    const code = handoverCode(DEAL, SECRET);
    const stored = handoverHash(DEAL, code);
    expect(stored).not.toContain(code);
    expect(codeMatches(stored, DEAL, code)).toBe(true);
    expect(codeMatches(stored, DEAL, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    expect(codeMatches(stored, DEAL, wrong)).toBe(false);
    expect(codeMatches(stored, "another-deal", code)).toBe(false);
  });

  it("rejects anything that is not six digits", () => {
    for (const bad of ["", "12345", "1234567", "12a456", "123456 or 1=1"]) {
      expect(normaliseCode(bad)).toBeNull();
    }
  });
});
