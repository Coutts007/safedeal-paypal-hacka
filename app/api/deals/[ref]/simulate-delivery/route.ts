import { and, desc, eq } from "drizzle-orm";
import { sendTestCourierEvent } from "@/lib/courier/webhook";
import { getDb } from "@/lib/db";
import { evidence } from "@/lib/db/schema";
import { serverEnv } from "@/lib/env";
import { fail, json, requireDeal, type RouteCtx } from "@/lib/http";

/**
 * DEMO_MODE only: the "Simulate courier delivery" button for judges. The test courier sends a
 * signed "delivered" event for the deal's tracking number, verified like any courier webhook.
 */
export async function POST(req: Request, { params }: RouteCtx) {
  const env = serverEnv();
  if (!env.DEMO_MODE || env.COURIER_MODE !== "test" || !env.TEST_COURIER_SECRET) {
    return fail(404, "not found");
  }
  const found = await requireDeal(req, (await params).ref);
  if (!found.ok) return found.response;
  const db = getDb();
  const [tracking] = await db
    .select({ number: evidence.trackingNumber })
    .from(evidence)
    .where(and(eq(evidence.dealId, found.deal.id), eq(evidence.type, "tracking")))
    .orderBy(desc(evidence.createdAt))
    .limit(1);
  if (!tracking?.number) return fail(409, "the seller has not added tracking yet");
  const out = await sendTestCourierEvent(
    db,
    { mode: "test", testSecret: env.TEST_COURIER_SECRET },
    { trackingNumber: tracking.number, at: new Date() },
  );
  return json(out.body, out.status);
}
