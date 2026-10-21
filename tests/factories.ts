import { eq } from "drizzle-orm";
import { vi } from "vitest";
import type { Db } from "@/lib/db";
import { deals, dealTerms, payments } from "@/lib/db/schema";
import { newPublicRef, newRoleToken } from "@/lib/deals/ids";
import { parseDealTerms, termsHash, type DealTerms } from "@/lib/deals/terms";
import type { EngineDeps, PaypalPort } from "@/lib/rules/engine";

export const TERMS_INPUT = {
  item: "Samsung Galaxy A15, used",
  quantity: 1,
  price: { amount: "95.00", currency: "USD" },
  deliveryMethod: "courier",
  carrier: "G4S",
  shipBy: null,
  deliverBy: null,
  conditions: [],
  payeeEmail: "seller-a@example.com",
};

export async function createDraftDeal(db: Db, input: unknown = TERMS_INPUT) {
  const terms: DealTerms = parseDealTerms(input, 500);
  const [deal] = await db
    .insert(deals)
    .values({ publicRef: newPublicRef(), sellerToken: newRoleToken(), buyerToken: newRoleToken() })
    .returning();
  const hash = termsHash(terms);
  await db.insert(dealTerms).values({
    dealId: deal.id,
    version: 1,
    termsJson: terms,
    termsHash: hash,
    proposedBy: "ai",
  });
  return { deal, hash };
}

export async function addPayment(db: Db, dealId: string, orderId: string, attempt = 1) {
  const [d] = await db.select().from(deals).where(eq(deals.id, dealId));
  await db.insert(payments).values({
    dealId,
    paypalOrderId: orderId,
    status: "CREATED",
    amount: d.amount ?? "0.00",
    currency: d.currency,
    attempt,
  });
}

const ok = <T>(value: T, status = 200) => ({ ok: true as const, value, status, debugId: "dbg" });
export const paypalError = (status: number | null, issue: string, retryable = false) => ({
  ok: false as const,
  status,
  debugId: "dbg",
  issue,
  retryable,
});

/** A fake PayPal that behaves like the sandbox did in the Phase 1 spike. */
export function fakePaypal() {
  const authStatus = new Map<string, string>();
  let orders = 0;
  const port = {
    createOrder: vi.fn<PaypalPort["createOrder"]>(async (src) =>
      ok({ id: `O${src.publicRef}N${++orders}`, status: "PAYER_ACTION_REQUIRED" }, 201),
    ),
    getOrder: vi.fn<PaypalPort["getOrder"]>(async (orderId, dealId) =>
      ok({
        id: orderId,
        status: "APPROVED",
        purchase_units: [
          { custom_id: dealId ?? undefined, amount: { currency_code: "USD", value: "95.00" } },
        ],
      }),
    ),
    authorizeOrder: vi.fn<PaypalPort["authorizeOrder"]>(async (orderId) => {
      const id = `AUTH-${orderId}`;
      authStatus.set(id, "CREATED");
      return ok({ id, status: "CREATED", expiresAt: new Date("2026-12-01T00:00:00Z") }, 201);
    }),
    capture: vi.fn<PaypalPort["capture"]>(async (authId) => {
      authStatus.set(authId, "CAPTURED");
      return ok({ id: `CAP-${authId}`, status: "COMPLETED" }, 201);
    }),
    voidAuth: vi.fn<PaypalPort["voidAuth"]>(async (authId) => {
      authStatus.set(authId, "VOIDED");
      return ok(null, 200);
    }),
    getAuth: vi.fn<PaypalPort["getAuth"]>(async (authId) =>
      ok({
        id: authId,
        status: authStatus.get(authId) ?? "CREATED",
        expiresAt: null,
        amount: "95.00",
      }),
    ),
    getDispute: vi.fn<PaypalPort["getDispute"]>(async (id) =>
      ok({ id, status: "OPEN", captureIds: [] }),
    ),
  } satisfies PaypalPort;
  return { port, authStatus };
}

export function testDeps(db: Db, paypal: PaypalPort, start: Date) {
  const clock = { now: new Date(start) };
  const deps: EngineDeps = { db, paypal, now: () => new Date(clock.now), timeScale: 1 };
  return { deps, clock, advance: (ms: number) => (clock.now = new Date(clock.now.getTime() + ms)) };
}
