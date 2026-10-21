import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { paymentRequests } from "@/lib/db/schema";
import { resetDb, testDb } from "@/tests/db";
import { createDraftDeal } from "@/tests/factories";
import { dbRecorder } from "./record";

const { db, close } = testDb();
afterAll(close);
beforeEach(() => resetDb(db));

describe("dbRecorder", () => {
  it("stores calls, and a replay with the same request id updates the row", async () => {
    const { deal } = await createDraftDeal(db);
    const record = dbRecorder(db);
    const call = {
      dealId: deal.id,
      action: "capture",
      method: "POST",
      path: "/v2/payments/authorizations/A1/capture",
      requestId: `deal-${deal.id}-capture-v1`,
    };
    await record({ ...call, status: null, json: null, debugId: null });
    await record({ ...call, status: 201, json: { id: "C1" }, debugId: "dbg" });
    await record({ ...call, requestId: null, method: "GET", status: 200, json: {}, debugId: "d2" });
    await record({ ...call, requestId: null, method: "GET", status: 200, json: {}, debugId: "d3" });

    const rows = await db.select().from(paymentRequests).where(eq(paymentRequests.dealId, deal.id));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.paypalRequestId === call.requestId)).toMatchObject({
      httpStatus: 201,
      responseJson: { id: "C1" },
      debugId: "dbg",
    });
  });
});
