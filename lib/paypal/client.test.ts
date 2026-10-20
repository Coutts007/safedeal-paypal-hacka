import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, paypalFetch, resetTokenCache } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  vi.stubEnv("DATABASE_URL", "postgres://x");
  vi.stubGlobal("fetch", fetchMock);
  resetTokenCache();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function tokenResponse(expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: "tok", expires_in: expiresIn }));
}

describe("getAccessToken", () => {
  it("caches the token until 60 s before expiry", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse(120)).mockResolvedValueOnce(tokenResponse(120));
    let now = 0;
    await getAccessToken(() => now);
    now = 59_000;
    await getAccessToken(() => now);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now = 61_000;
    await getAccessToken(() => now);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports status and debug id, not credentials, on failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 401, headers: { "paypal-debug-id": "abc123" } }),
    );
    const err = await getAccessToken().catch((e: Error) => e);
    expect(String(err)).toContain("HTTP 401 (debug_id abc123)");
    expect(String(err)).not.toContain("test-secret");
  });
});

describe("paypalFetch", () => {
  it("sends bearer token, PayPal-Request-Id and Prefer header", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "O1" }), { headers: { "paypal-debug-id": "d1" } }),
      );
    const res = await paypalFetch<{ id: string }>("/v2/checkout/orders", {
      method: "POST",
      requestId: "deal-x-create-v1",
      body: { intent: "AUTHORIZE" },
    });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["PayPal-Request-Id"]).toBe("deal-x-create-v1");
    expect(headers.Prefer).toBe("return=representation");
    expect(res).toMatchObject({ ok: true, status: 200, debugId: "d1", json: { id: "O1" } });
  });

  it("refuses a POST without a request id", async () => {
    await expect(paypalFetch("/v2/checkout/orders", { method: "POST" })).rejects.toThrow(
      "PayPal-Request-Id",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles an empty 204 body", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await paypalFetch("/v2/payments/authorizations/A1/void", {
      method: "POST",
      requestId: "deal-x-void-v1",
    });
    expect(res).toMatchObject({ ok: true, status: 204, json: {} });
  });
});
