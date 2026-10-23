import { adminDeal } from "@/lib/admin/queries";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { fail, requireDeal, type RouteCtx } from "@/lib/http";

/**
 * Evidence bundle for a PayPal dispute (section 7.1): confirmed terms, tracking, courier events,
 * handover record, timestamps and the audit log, for the seller to upload in PayPal's Resolution
 * Center. Photos are listed by id and SHA-256 in the audit log; the AI's advice is not included.
 */
export async function GET(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref);
  if (!found.ok) return found.response;
  if (!["CAPTURED", "DISPUTED", "CLOSED"].includes(found.deal.state)) {
    return fail(409, "the evidence bundle is for paid deals");
  }
  const full: Partial<Awaited<ReturnType<typeof adminDeal>>> = await adminDeal(
    getDb(),
    found.deal,
    {
      now: new Date(),
      timeScale: serverEnv().DEMO_TIME_SCALE,
    },
  );
  // Reviewer-only fields stay out of the bundle.
  delete full.checks;
  delete full.canDecide;
  const bundle = full;
  return new Response(
    JSON.stringify(
      { generatedAt: new Date().toISOString(), service: "SafeDeal", ...bundle },
      null,
      2,
    ),
    {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="safedeal-${found.deal.publicRef}-evidence.json"`,
        "Cache-Control": "no-store",
      },
    },
  );
}
