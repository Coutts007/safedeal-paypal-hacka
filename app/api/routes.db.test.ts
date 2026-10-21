import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { deals, webhookEvents } from "@/lib/db/schema";
import { setEngineDeps } from "@/lib/rules/engine";
import { resetDb } from "@/tests/db";
import { fakePaypal, TERMS_INPUT, testDeps } from "@/tests/factories";
import { POST as createDealRoute } from "./deals/route";
import { GET as getDealRoute } from "./deals/[ref]/route";
import { POST as authorizeRoute } from "./deals/[ref]/authorize/route";
import { POST as cancelRoute } from "./deals/[ref]/cancel/route";
import { POST as confirmRoute } from "./deals/[ref]/confirm/route";
import { POST as evidenceRoute } from "./deals/[ref]/evidence/route";
import { POST as orderRoute } from "./deals/[ref]/order/route";
import { POST as receiptRoute } from "./deals/[ref]/receipt/route";
import { POST as termsRoute } from "./deals/[ref]/terms/route";
import { GET as healthRoute } from "./health/route";
import { POST as sweepRoute } from "./cron/sweep/route";
import { POST as paypalWebhookRoute } from "./webhooks/paypal/route";

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  // Outside a real request `after` would throw; run the callback straight away instead.
  after: (fn: () => unknown) => void fn(),
}));

const verify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/paypal/webhooks", () => ({ verifyPaypalWebhook: verify }));

const H = 3_600_000;
const db = getDb();
let fake: ReturnType<typeof fakePaypal>;
let clock: ReturnType<typeof testDeps>;

beforeEach(async () => {
  await resetDb(db);
  fake = fakePaypal();
  clock = testDeps(db, fake.port, new Date("2026-11-01T09:00:00Z"));
  setEngineDeps(clock.deps);
  verify.mockReset();
});
afterEach(() => setEngineDeps(undefined));
afterAll(closeDb);

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (ref: string) => ({ params: Promise.resolve({ ref }) });
const as = (token: string) => ({ "x-deal-token": token });

async function newDeal() {
  const res = await createDealRoute(
    req("POST", { sellerName: "David", buyerName: "Shemaya", terms: TERMS_INPUT }),
  );
  expect(res.status).toBe(201);
  const { ref, links } = (await res.json()) as {
    ref: string;
    links: { seller: string; buyer: string };
  };
  const token = (l: string) => decodeURIComponent(new URL(l).searchParams.get("t") as string);
  return { ref, seller: token(links.seller), buyer: token(links.buyer) };
}

async function view(ref: string, token: string) {
  const res = await getDealRoute(req("GET", undefined, as(token)), ctx(ref));
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown> & {
      termsHash: string;
      state: string;
      actions: string[];
    },
  };
}

async function agreed() {
  const d = await newDeal();
  const { body } = await view(d.ref, d.seller);
  await confirmRoute(req("POST", { termsHash: body.termsHash }, as(d.seller)), ctx(d.ref));
  await confirmRoute(req("POST", { termsHash: body.termsHash }, as(d.buyer)), ctx(d.ref));
  return d;
}

describe("creating and viewing deals", () => {
  it("creates a DRAFT and gives each party a view for their role only", async () => {
    const d = await newDeal();
    const seller = await view(d.ref, d.seller);
    expect(seller.body).toMatchObject({
      role: "seller",
      state: "DRAFT",
      names: { seller: "David", buyer: "Shemaya" },
    });
    expect(seller.body.buyerLink).toContain(d.ref);
    const buyer = await view(d.ref, d.buyer);
    expect(buyer.body).toMatchObject({ role: "buyer", buyerLink: null });
    expect(JSON.stringify(buyer.body)).not.toContain(d.seller);
  });

  it("answers 404 for a wrong token or unknown ref", async () => {
    const d = await newDeal();
    expect((await view(d.ref, "wrong")).status).toBe(404);
    expect((await view("ZZZZZZZZZZ", d.seller)).status).toBe(404);
    expect((await getDealRoute(req("GET"), ctx(d.ref))).status).toBe(404);
  });

  it("rejects bad terms and amounts over the cap", async () => {
    const bad = await createDealRoute(
      req("POST", {
        sellerName: "D",
        buyerName: "S",
        terms: { ...TERMS_INPUT, price: { amount: "600.00", currency: "USD" } },
      }),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("cap");
    expect((await createDealRoute(req("POST", { sellerName: "D" }))).status).toBe(400);
  });
});

describe("terms", () => {
  it("a terms change after one confirmation makes the old hash stale", async () => {
    const d = await newDeal();
    const v1 = (await view(d.ref, d.seller)).body.termsHash;
    await confirmRoute(req("POST", { termsHash: v1 }, as(d.seller)), ctx(d.ref));
    const edit = await termsRoute(
      req(
        "POST",
        { terms: { ...TERMS_INPUT, price: { amount: "90.00", currency: "USD" } } },
        as(d.buyer),
      ),
      ctx(d.ref),
    );
    expect(edit.status).toBe(200);
    const stale = await confirmRoute(req("POST", { termsHash: v1 }, as(d.buyer)), ctx(d.ref));
    expect(stale.status).toBe(409);
    const v2 = (await view(d.ref, d.buyer)).body;
    expect(v2).toMatchObject({ termsVersion: 2, confirmed: { buyer: false, seller: false } });
  });
});

describe("payment flow", () => {
  it("runs DRAFT → AGREED → AUTHORIZED → SHIPPED → CAPTURED through the routes", async () => {
    const d = await agreed();
    expect((await view(d.ref, d.buyer)).body).toMatchObject({
      state: "AGREED",
      actions: ["pay", "cancel"],
    });

    expect((await orderRoute(req("POST", {}, as(d.seller)), ctx(d.ref))).status).toBe(403);
    const order = await orderRoute(req("POST", {}, as(d.buyer)), ctx(d.ref));
    const { id } = (await order.json()) as { id: string };
    expect(id).toMatch(/^O[0-9A-Z]+N1$/);
    expect(fake.port.createOrder.mock.calls[0][0]).toMatchObject({
      amount: "95.00",
      payeeEmail: "seller-a@example.com",
    });
    // A second click reuses the same order.
    const again = (await (await orderRoute(req("POST", {}, as(d.buyer)), ctx(d.ref))).json()) as {
      id: string;
    };
    expect(again.id).toBe(id);

    const auth = await authorizeRoute(req("POST", { orderId: id }, as(d.buyer)), ctx(d.ref));
    expect(await auth.json()).toMatchObject({ outcome: "moved", to: "AUTHORIZED" });

    const ev = await evidenceRoute(
      req("POST", { carrier: "G4S", trackingNumber: "G4S-123" }, as(d.seller)),
      ctx(d.ref),
    );
    expect(await ev.json()).toMatchObject({ to: "SHIPPED" });
    expect((await view(d.ref, d.buyer)).body.actions).toEqual([
      "confirm_receipt",
      "report_problem",
    ]);

    const paid = await receiptRoute(req("POST", { action: "confirm" }, as(d.buyer)), ctx(d.ref));
    expect(await paid.json()).toMatchObject({ to: "CAPTURED" });
    const final = (await view(d.ref, d.seller)).body as unknown as {
      timeline: { state: string }[];
      state: string;
    };
    expect(final.state).toBe("CAPTURED");
    expect(final.timeline.every((s) => s.state === "done")).toBe(true);
  });

  it("only the buyer can confirm receipt, and only the seller can add tracking", async () => {
    const d = await agreed();
    expect(
      (await receiptRoute(req("POST", { action: "confirm" }, as(d.seller)), ctx(d.ref))).status,
    ).toBe(403);
    expect(
      (
        await evidenceRoute(
          req("POST", { carrier: "G4S", trackingNumber: "T-1" }, as(d.buyer)),
          ctx(d.ref),
        )
      ).status,
    ).toBe(403);
  });

  it("refuses an authorise for an order that is not the deal's", async () => {
    const d = await agreed();
    await orderRoute(req("POST", {}, as(d.buyer)), ctx(d.ref));
    const res = await authorizeRoute(
      req("POST", { orderId: "FORGED123" }, as(d.buyer)),
      ctx(d.ref),
    );
    expect(res.status).toBe(409);
  });

  it("a declined authorisation can be retried with a new order and request id", async () => {
    const d = await agreed();
    const first = (await (await orderRoute(req("POST", {}, as(d.buyer)), ctx(d.ref))).json()) as {
      id: string;
    };
    fake.port.authorizeOrder.mockResolvedValueOnce({
      ok: false,
      status: 422,
      debugId: "d",
      issue: "INSTRUMENT_DECLINED",
      retryable: false,
    });
    fake.port.getOrder.mockResolvedValueOnce({
      ok: true,
      status: 200,
      debugId: "d",
      value: {
        id: first.id,
        status: "APPROVED",
        purchase_units: [
          { custom_id: await dealId(d.ref), amount: { currency_code: "USD", value: "95.00" } },
        ],
      },
    });
    fake.port.getOrder.mockResolvedValueOnce({
      ok: true,
      status: 200,
      debugId: "d",
      value: { id: first.id, status: "APPROVED" },
    });
    expect(
      await (
        await authorizeRoute(req("POST", { orderId: first.id }, as(d.buyer)), ctx(d.ref))
      ).json(),
    ).toMatchObject({
      to: "FUNDING_FAILED",
    });
    const second = (await (await orderRoute(req("POST", {}, as(d.buyer)), ctx(d.ref))).json()) as {
      id: string;
    };
    expect(second.id).not.toBe(first.id);
    expect(fake.port.createOrder.mock.calls[1][1]).toMatch(/-create-v2$/);
    expect(
      await (
        await authorizeRoute(req("POST", { orderId: second.id }, as(d.buyer)), ctx(d.ref))
      ).json(),
    ).toMatchObject({
      to: "AUTHORIZED",
    });
    expect(fake.port.authorizeOrder.mock.calls[1][1]).toMatch(/-authorize-v2$/);
  });

  it("either party can cancel before payment", async () => {
    const d = await agreed();
    expect(
      await (await cancelRoute(req("POST", {}, as(d.seller)), ctx(d.ref))).json(),
    ).toMatchObject({ to: "CANCELLED" });
  });
});

async function dealId(ref: string) {
  const [row] = await db.select({ id: deals.id }).from(deals).where(eq(deals.publicRef, ref));
  return row.id;
}

describe("cron sweep route", () => {
  it("needs the secret, then voids a deal past ship-by", async () => {
    const d = await agreed();
    const { id } = (await (await orderRoute(req("POST", {}, as(d.buyer)), ctx(d.ref))).json()) as {
      id: string;
    };
    await authorizeRoute(req("POST", { orderId: id }, as(d.buyer)), ctx(d.ref));

    expect((await sweepRoute(req("POST"))).status).toBe(401);
    expect((await sweepRoute(req("POST", undefined, { "x-cron-secret": "nope" }))).status).toBe(
      401,
    );
    clock.advance(48 * H);
    const res = await sweepRoute(req("POST", undefined, { "x-cron-secret": "test-cron-secret" }));
    expect(await res.json()).toMatchObject({
      checked: 1,
      changed: [{ outcome: "moved", to: "VOIDED" }],
    });
  });
});

describe("PayPal webhook route", () => {
  const event = (id: string) => ({
    id,
    event_type: "PAYMENT.AUTHORIZATION.VOIDED",
    resource: { id: "AUTH-X" },
  });

  it("refuses an unverified event and stores nothing", async () => {
    verify.mockResolvedValueOnce({ verified: false, reason: "verification_status FAILURE" });
    const res = await paypalWebhookRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify(event("WH-1")) }),
    );
    expect(res.status).toBe(400);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("asks PayPal to redeliver when verification is unavailable", async () => {
    verify.mockResolvedValueOnce({ verified: false, reason: "verification call failed: HTTP_503" });
    const res = await paypalWebhookRoute(new Request("http://x", { method: "POST", body: "{}" }));
    expect(res.status).toBe(503);
  });

  it("stores a verified event once, processes it, and ignores the repeat", async () => {
    const body = JSON.stringify(event("WH-2"));
    verify.mockResolvedValue({ verified: true, event: event("WH-2") });
    const first = await paypalWebhookRoute(new Request("http://x", { method: "POST", body }));
    expect(await first.json()).toEqual({ received: true });
    const second = await paypalWebhookRoute(new Request("http://x", { method: "POST", body }));
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    await vi.waitFor(async () => {
      const [row] = await db.select().from(webhookEvents);
      expect(row.processedAt).not.toBeNull();
    });
  });
});

describe("health", () => {
  it("reports the database as reachable", async () => {
    const res = await healthRoute();
    expect(await res.json()).toEqual({ ok: true, db: "ok" });
  });
});
