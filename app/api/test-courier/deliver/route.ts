import { z } from "zod";
import { sendTestCourierEvent } from "@/lib/courier/webhook";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { fail, json, readJson } from "@/lib/http";
import { secretMatches } from "@/lib/secrets";

const body = z.object({
  trackingNumber: z.string().trim().min(3).max(60),
  status: z.enum(["in_transit", "out_for_delivery", "delivered", "failed_attempt"]).optional(),
});

/**
 * Demo only: the test courier sends a signed event for a tracking number. Needs the
 * `x-test-courier-secret` header (TEST_COURIER_SECRET), so only Peter and scripts can call it.
 */
export async function POST(req: Request) {
  const env = serverEnv();
  if (env.COURIER_MODE !== "test") return fail(404, "not found");
  if (!env.TEST_COURIER_SECRET) return fail(503, "TEST_COURIER_SECRET is not set");
  if (!secretMatches(req.headers.get("x-test-courier-secret"), env.TEST_COURIER_SECRET)) {
    return fail(401, "unauthorised");
  }
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  const out = await sendTestCourierEvent(
    getDb(),
    { mode: "test", testSecret: env.TEST_COURIER_SECRET },
    { ...input.data, at: new Date() },
  );
  return json(out.body, out.status);
}
