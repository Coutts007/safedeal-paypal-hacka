import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerEnvCache } from "@/lib/env";
import { resetTokenCache } from "./client";
import { authorizeOrder, buildOrderBody, createOrder } from "./orders";
import { capture, getAuth, voidAuth } from "./payments";
import { verifyPaypalWebhook } from "./webhooks";

const fetchMock = vi.fn();
const DEAL = "0b6f1c1e-3c55-4a8e-9a0f-1d2b3c4d5e6f";

beforeEach(() => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  vi.stubEnv("DATABASE_URL", "postgres://x");
  vi.stubGlobal("fetch", fetchMock);
  resetTokenCache();
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { "paypal-debug-id": "dbg" } }),
  );
}

function sent(n = 1) {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  };
}

const src = {
  dealId: DEAL,
  publicRef: "7K3QH9XM2C",
  amount: "95.00",
  currency: "USD" as const,
  payeeEmail: "seller@example.com",
  description: "x".repeat(200),
};

describe("orders", () => {
  it("builds an AUTHORIZE order from the deal row with payee, custom_id and a 127-char description", () => {
    const body = buildOrderBody(src);
    expect(body.intent).toBe("AUTHORIZE");
    expect(body.purchase_units[0]).toMatchObject({
      reference_id: "7K3QH9XM2C",
      custom_id: DEAL,
      amount: { currency_code: "USD", value: "95.00" },
      payee: { email_address: "seller@example.com" },
    });
    expect(body.purchase_units[0].description).toHaveLength(127);
  });

  it("refuses an amount that is not a 2-decimal string", () => {
    expect(() => buildOrderBody({ ...src, amount: "95" })).toThrow();
  });

  it("createOrder posts with the given request id", async () => {
    reply(201, { id: "O1", status: "CREATED" });
    const res = await createOrder(src, `deal-${DEAL}-create-v1`);
    expect(res).toMatchObject({ ok: true, value: { id: "O1" } });
    expect(sent().headers["PayPal-Request-Id"]).toBe(`deal-${DEAL}-create-v1`);
  });

  it("authorizeOrder returns the authorization id, status and expiry", async () => {
    reply(201, {
      id: "O1",
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            authorizations: [
              { id: "A1", status: "CREATED", expiration_time: "2026-11-19T11:47:53Z" },
            ],
          },
        },
      ],
    });
    const res = await authorizeOrder("O1", `deal-${DEAL}-authorize-v1`, DEAL);
    expect(res).toEqual({
      ok: true,
      status: 201,
      debugId: "dbg",
      value: { id: "A1", status: "CREATED", expiresAt: new Date("2026-11-19T11:47:53Z") },
    });
    expect(sent().url).toContain("/v2/checkout/orders/O1/authorize");
  });

  it("reports a 422 as a non-retryable failure with PayPal's issue code", async () => {
    reply(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
    const res = await authorizeOrder("O1", "k", DEAL);
    expect(res).toEqual({
      ok: false,
      status: 422,
      debugId: "dbg",
      issue: "ORDER_NOT_APPROVED",
      retryable: false,
    });
  });
});

describe("payments", () => {
  it("capture sends final_capture true", async () => {
    reply(201, { id: "C1", status: "COMPLETED" });
    const res = await capture("A1", "k", DEAL);
    expect(res).toMatchObject({ ok: true, value: { id: "C1", status: "COMPLETED" } });
    expect(sent()).toMatchObject({
      url: expect.stringContaining("/v2/payments/authorizations/A1/capture"),
      body: { final_capture: true },
    });
  });

  it("marks 5xx and 429 as retryable", async () => {
    reply(503, { name: "SERVICE_UNAVAILABLE" });
    expect(await capture("A1", "k", DEAL)).toMatchObject({ ok: false, retryable: true });
  });

  it("voidAuth accepts an empty 204 reply", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await voidAuth("A1", "k", DEAL)).toMatchObject({ ok: true, status: 204 });
  });

  it("getAuth parses status, expiry and amount", async () => {
    reply(200, {
      id: "A1",
      status: "VOIDED",
      expiration_time: "2026-11-19T11:47:53Z",
      amount: { currency_code: "USD", value: "12.00" },
    });
    expect(await getAuth("A1", DEAL)).toMatchObject({
      ok: true,
      value: { status: "VOIDED", amount: "12.00", expiresAt: new Date("2026-11-19T11:47:53Z") },
    });
  });

  it("escapes ids placed in the path", async () => {
    reply(200, { id: "x", status: "CREATED" });
    await getAuth("../../v1/x", DEAL);
    expect(sent().url).toContain("/v2/payments/authorizations/..%2F..%2Fv1%2Fx");
  });
});

describe("verifyPaypalWebhook", () => {
  const headers = new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
    "paypal-transmission-id": "T1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-10-21T10:00:00Z",
  });
  const body = JSON.stringify({
    id: "WH-1",
    event_type: "PAYMENT.AUTHORIZATION.VOIDED",
    resource: { id: "A1" },
  });

  it("refuses when PAYPAL_WEBHOOK_ID is not set, without calling PayPal", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    resetServerEnvCache();
    expect(await verifyPaypalWebhook(headers, body)).toEqual({
      verified: false,
      reason: "PAYPAL_WEBHOOK_ID is not set",
    });
  });

  it("refuses when a signature header is missing", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WHID");
    resetServerEnvCache();
    const h = new Headers(headers);
    h.delete("paypal-transmission-sig");
    expect(await verifyPaypalWebhook(h, body)).toMatchObject({ verified: false });
  });

  it("sends the headers, webhook id and parsed event; accepts only SUCCESS", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WHID");
    resetServerEnvCache();
    reply(200, { verification_status: "SUCCESS" });
    const ok = await verifyPaypalWebhook(headers, body);
    expect(ok).toMatchObject({ verified: true, event: { id: "WH-1" } });
    expect(sent().body).toMatchObject({
      auth_algo: "SHA256withRSA",
      transmission_id: "T1",
      webhook_id: "WHID",
      webhook_event: { id: "WH-1" },
    });

    reply(200, { verification_status: "FAILURE" });
    expect(await verifyPaypalWebhook(headers, body)).toEqual({
      verified: false,
      reason: "verification_status FAILURE",
    });
  });
});
