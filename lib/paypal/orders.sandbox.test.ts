import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { serverEnv } from "@/lib/env";
import { createOrder, getOrder } from "./orders";
import { getAuth, voidAuth } from "./payments";
import { paypalRequestId } from "./request-id";

// Runs against the real PayPal sandbox with the keys in `.env` (`npm run test:sandbox`).
// Creating an order moves no money. An order cannot be authorised (and so voided) without a buyer
// approving it in the browser; that path was proven in the Phase 1 spike. To also void a real
// authorisation, set SANDBOX_VOID_AUTH_ID to one that is still CREATED.

describe("PayPal sandbox", () => {
  const dealId = randomUUID();
  const src = () => ({
    dealId,
    publicRef: "SANDBOXTST",
    amount: "12.00",
    currency: "USD" as const,
    payeeEmail: serverEnv().SANDBOX_SELLER_A_EMAIL,
    description: "SafeDeal Phase 2 sandbox integration test",
  });

  it("creates an AUTHORIZE order for seller A, and a replay with the same key returns the same order", async () => {
    expect(serverEnv().SANDBOX_SELLER_A_EMAIL).not.toBe("");
    const key = paypalRequestId(dealId, "create", 1);
    const first = await createOrder(src(), key);
    if (!first.ok) throw new Error(`create failed: ${first.issue} (debug_id ${first.debugId})`);
    expect(first.value.status).toMatch(/^(CREATED|PAYER_ACTION_REQUIRED)$/);
    const unit = first.value.purchase_units?.[0];
    expect(unit?.custom_id).toBe(dealId);
    expect(unit?.amount).toEqual({ currency_code: "USD", value: "12.00" });
    expect(unit?.payee?.email_address?.toLowerCase()).toBe(src().payeeEmail.toLowerCase());

    const replay = await createOrder(src(), key);
    expect(replay.ok && replay.value.id).toBe(first.value.id);

    const read = await getOrder(first.value.id, dealId);
    expect(read.ok && read.value.status).toBe(first.value.status);
  });

  it("accepts seller B as a payee too", async () => {
    const sellerB = serverEnv().SANDBOX_SELLER_B_EMAIL;
    expect(sellerB).not.toBe("");
    const id = randomUUID();
    const res = await createOrder(
      { ...src(), dealId: id, payeeEmail: sellerB },
      paypalRequestId(id, "create", 1),
    );
    if (!res.ok) throw new Error(`create failed: ${res.issue} (debug_id ${res.debugId})`);
    const payee = res.value.purchase_units?.[0]?.payee?.email_address;
    expect(payee?.toLowerCase()).toBe(sellerB.toLowerCase());
  });

  it("reports an unknown authorisation as a non-retryable failure", async () => {
    const res = await getAuth("0NOTREAL00000000X", null);
    expect(res).toMatchObject({ ok: false, retryable: false });
  });

  it.runIf(process.env.SANDBOX_VOID_AUTH_ID)("voids a real authorisation", async () => {
    const authId = process.env.SANDBOX_VOID_AUTH_ID as string;
    const res = await voidAuth(authId, `sandbox-test-${authId}-void-v1`, dealId);
    if (!res.ok) throw new Error(`void failed: ${res.issue} (debug_id ${res.debugId})`);
    const after = await getAuth(authId, null);
    expect(after.ok && after.value.status).toBe("VOIDED");
  });
});
