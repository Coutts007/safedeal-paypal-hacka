import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deals } from "@/lib/db/schema";
import { onBuyerApproved } from "@/lib/rules/engine";
import { resetDb, testDb } from "@/tests/db";
import { addPayment, fakePaypal, testDeps } from "@/tests/factories";
import { demoReset } from "./demo";

const START = new Date("2026-11-05T07:00:00Z");
const { db, close } = testDb();
afterAll(close);
beforeEach(() => resetDb(db));

describe("demo reset", () => {
  it("creates A and B agreed, B with a short ship-by; cancels earlier unpaid demo deals and leaves held ones", async () => {
    const fake = fakePaypal();
    const { deps } = testDeps(db, fake.port, START);
    const opts = {
      sellerA: "seller-a@business.example.com",
      sellerB: "seller-b@business.example.com",
      now: START,
      shipMinutes: 15,
      maxDealUsd: 500,
      deps,
    };
    const first = await demoReset(db, opts);
    expect(first.created.map((c) => [c.demo.label, c.terms.price.amount])).toEqual([
      ["A", "95.00"],
      ["B", "40.00"],
    ]);
    const [a, b] = first.created.map((c) => c.deal);
    expect(first.created[1].terms.shipBy).toBe("2026-11-05T07:15:00.000Z");

    // Deal A gets paid (money held); B stays unpaid.
    await addPayment(db, a.id, `ORDER-${a.publicRef}`);
    await onBuyerApproved(a.id, `ORDER-${a.publicRef}`, deps);

    const second = await demoReset(db, opts);
    expect(second.cancelled).toEqual([b.publicRef]);
    expect(second.held).toEqual([{ ref: a.publicRef, state: "AUTHORIZED" }]);
    const state = async (id: string) => (await db.select().from(deals).where(eq(deals.id, id)))[0];
    expect(await state(a.id)).toMatchObject({ state: "AUTHORIZED" });
    expect(await state(b.id)).toMatchObject({ state: "CANCELLED" });
    for (const c of second.created) expect((await state(c.deal.id)).state).toBe("AGREED");
    // The reset never calls PayPal.
    expect(fake.port.capture).not.toHaveBeenCalled();
    expect(fake.port.voidAuth).not.toHaveBeenCalled();
  });
});
