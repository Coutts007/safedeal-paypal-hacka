import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAccessToken,
  paypalFetch,
  resetTokenCache,
  setPaypalRecorder,
  type PaypalCallRecord,
} from "./client";

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
  setPaypalRecorder(undefined);
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

describe("network retries", () => {
  it("retries a network failure with the same request id, then succeeds", async () => {
    vi.useFakeTimers();
    const netErr = new TypeError("fetch failed", {
      cause: Object.assign(new AggregateError([]), {
        errors: [{ code: "ETIMEDOUT" }, { code: "ENETUNREACH" }],
      }),
    });
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "O1" })));
    const pending = paypalFetch("/v2/checkout/orders", {
      method: "POST",
      requestId: "deal-x-create-v1",
      body: {},
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ ok: true, json: { id: "O1" } });
    const keys = fetchMock.mock.calls
      .slice(1)
      .map(([, init]) => (init as RequestInit & { headers: Record<string, string> }).headers);
    expect(keys.map((h) => h["PayPal-Request-Id"])).toEqual([
      "deal-x-create-v1",
      "deal-x-create-v1",
    ]);
    vi.useRealTimers();
  });

  it("gives up after 3 attempts and names the network error", async () => {
    vi.useFakeTimers();
    const netErr = new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } });
    fetchMock.mockRejectedValue(netErr);
    const pending = getAccessToken().catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect(String(await pending)).toContain("unreachable after 3 attempts (ETIMEDOUT)");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("does not retry an HTTP error response", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("{}", { status: 422 }));
    const res = await paypalFetch("/v2/x", { method: "POST", requestId: "k" });
    expect(res.status).toBe(422);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("call recording", () => {
  it("records a call made with `record`, including status and debug id", async () => {
    const calls: PaypalCallRecord[] = [];
    setPaypalRecorder(async (c) => void calls.push(c));
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "UNPROCESSABLE_ENTITY" }), {
        status: 422,
        headers: { "paypal-debug-id": "dbg" },
      }),
    );
    await paypalFetch("/v2/payments/authorizations/A1/capture", {
      method: "POST",
      requestId: "deal-x-capture-v1",
      record: { dealId: "d1", action: "capture" },
    });
    expect(calls).toEqual([
      {
        dealId: "d1",
        action: "capture",
        method: "POST",
        path: "/v2/payments/authorizations/A1/capture",
        requestId: "deal-x-capture-v1",
        status: 422,
        json: { name: "UNPROCESSABLE_ENTITY" },
        debugId: "dbg",
      },
    ]);
  });

  it("records a network failure with a null status and still throws", async () => {
    vi.useFakeTimers();
    const calls: PaypalCallRecord[] = [];
    setPaypalRecorder(async (c) => void calls.push(c));
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
    const pending = paypalFetch("/v2/x", {
      method: "POST",
      requestId: "k",
      record: { dealId: null, action: "void" },
    }).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect(String(await pending)).toContain("ECONNRESET");
    expect(calls[0]).toMatchObject({ status: null, requestId: "k", action: "void" });
    vi.useRealTimers();
  });

  it("does not record calls without `record`, and a failing recorder does not break the call", async () => {
    const recorder = vi.fn().mockRejectedValue(new Error("db down"));
    setPaypalRecorder(recorder);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "O1" })));
    await paypalFetch("/v2/a");
    expect(recorder).not.toHaveBeenCalled();
    const res = await paypalFetch("/v2/b", { record: { dealId: null, action: "get" } });
    expect(res.json).toEqual({ id: "O1" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
