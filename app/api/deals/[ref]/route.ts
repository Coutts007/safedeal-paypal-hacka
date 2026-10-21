import { getDb } from "@/lib/db";
import { dealView } from "@/lib/deals/service";
import { serverEnv } from "@/lib/env";
import { json, requireDeal, type RouteCtx } from "@/lib/http";

export async function GET(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref);
  if (!found.ok) return found.response;
  const env = serverEnv();
  const view = await dealView(getDb(), found.deal, found.role, {
    now: new Date(),
    timeScale: env.DEMO_TIME_SCALE,
    kesPerUsd: env.KES_PER_USD,
    appBaseUrl: env.APP_BASE_URL,
  });
  return json(view);
}
