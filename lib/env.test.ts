import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./env";

const base = {
  PAYPAL_CLIENT_ID: "test-client-id",
  PAYPAL_CLIENT_SECRET: "test-client-secret",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
};

describe("parseServerEnv", () => {
  it("applies defaults", () => {
    const env = parseServerEnv(base);
    expect(env.PAYPAL_API_BASE).toBe("https://api-m.sandbox.paypal.com");
    expect(env.DEMO_TIME_SCALE).toBe(1);
    expect(env.DEMO_MODE).toBe(false);
    expect(env.MAX_DEAL_USD).toBe(500);
  });

  it("strips inline comments copied from .env.example", () => {
    const env = parseServerEnv({ ...base, COURIER_MODE: "test          # test | aftership" });
    expect(env.COURIER_MODE).toBe("test");
  });

  it("names missing variables without printing any values", () => {
    expect(() => parseServerEnv({ PAYPAL_CLIENT_SECRET: "super-secret-value" })).toThrowError(
      /PAYPAL_CLIENT_ID.*DATABASE_URL/,
    );
    try {
      parseServerEnv({ PAYPAL_CLIENT_SECRET: "super-secret-value" });
    } catch (e) {
      expect(String(e)).not.toContain("super-secret-value");
    }
  });

  it("refuses the live PayPal API", () => {
    expect(() => parseServerEnv({ ...base, PAYPAL_API_BASE: "https://api-m.paypal.com" })).toThrow(
      /sandbox only/,
    );
  });
});
