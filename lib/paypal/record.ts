import type { Db } from "@/lib/db";
import { paymentRequests } from "@/lib/db/schema";
import { setPaypalRecorder, type PaypalCallRecord } from "./client";

/**
 * Store PayPal calls in `payment_requests`. Uses its own connection (not the deal transaction),
 * so a call is kept even when the transaction that made it rolls back. A replay with the same
 * PayPal-Request-Id updates the row with the latest response.
 */
export function dbRecorder(db: Db) {
  return async (c: PaypalCallRecord) => {
    const row = {
      dealId: c.dealId,
      action: c.action,
      method: c.method,
      path: c.path,
      paypalRequestId: c.requestId,
      httpStatus: c.status,
      responseJson: c.json,
      debugId: c.debugId,
    };
    if (c.requestId === null) {
      await db.insert(paymentRequests).values(row);
      return;
    }
    await db
      .insert(paymentRequests)
      .values(row)
      .onConflictDoUpdate({
        target: paymentRequests.paypalRequestId,
        set: { httpStatus: row.httpStatus, responseJson: row.responseJson, debugId: row.debugId },
      });
  };
}

export function useDbRecorder(db: Db): void {
  setPaypalRecorder(dbRecorder(db));
}
