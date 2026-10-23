import { handleCourierWebhook } from "@/lib/courier/webhook";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { json } from "@/lib/http";

/** Courier webhook (rule 4): raw body, HMAC check, stored once, then the engine decides. */
export async function POST(req: Request) {
  const raw = await req.text();
  const env = serverEnv();
  const out = await handleCourierWebhook(getDb(), raw, req.headers, {
    mode: env.COURIER_MODE,
    testSecret: env.TEST_COURIER_SECRET,
  });
  if (out.status !== 200) console.warn(`Courier webhook refused: ${out.body.error}`);
  return json(out.body, out.status);
}
