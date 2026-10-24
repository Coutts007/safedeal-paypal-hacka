import { eq } from "drizzle-orm";
import { adminDeal, type AdminDealView } from "@/lib/admin/queries";
import { getDb } from "@/lib/db";
import { evidenceFiles } from "@/lib/db/schema";
import { bundlePdf, type BundleRecord } from "@/lib/deals/bundle";
import { serverEnv } from "@/lib/env";
import { fail, requireDeal, type RouteCtx } from "@/lib/http";

/**
 * Evidence bundle for a PayPal dispute (section 7.1), for the seller or buyer to upload in PayPal's
 * Resolution Center: a readable PDF of the confirmed terms, payment, tracking, courier events,
 * handover record, the parties' photos and notes, reviews, the timeline and the chat
 * (lib/deals/bundle.ts). `?format=json` returns the same record as data. The AI's advice is not
 * included.
 */
export async function GET(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref);
  if (!found.ok) return found.response;
  if (!["CAPTURED", "DISPUTED", "CLOSED"].includes(found.deal.state)) {
    return fail(409, "the evidence bundle is for paid deals");
  }
  const db = getDb();
  const now = new Date();
  const view: Partial<AdminDealView> = await adminDeal(db, found.deal, {
    now,
    timeScale: serverEnv().DEMO_TIME_SCALE,
  });
  // Reviewer-only fields (the AI's advice, the decide button) stay out of the bundle.
  delete view.checks;
  delete view.canDecide;
  const record = view as BundleRecord;
  const name = `safedeal-${found.deal.publicRef}-evidence`;
  const headers = (type: string, ext: string) => ({
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${name}.${ext}"`,
    "Cache-Control": "no-store",
  });

  if (new URL(req.url).searchParams.get("format") === "json") {
    return new Response(
      JSON.stringify({ generatedAt: now.toISOString(), service: "SafeDeal", ...record }, null, 2),
      { headers: headers("application/json", "json") },
    );
  }

  const photos = await db
    .select({
      evidenceId: evidenceFiles.evidenceId,
      contentType: evidenceFiles.contentType,
      sha256: evidenceFiles.sha256,
      sizeBytes: evidenceFiles.sizeBytes,
      data: evidenceFiles.data,
    })
    .from(evidenceFiles)
    .where(eq(evidenceFiles.dealId, found.deal.id));
  const pdf = await bundlePdf({ ...record, generatedAt: now, photos });
  return new Response(Buffer.from(pdf), { headers: headers("application/pdf", "pdf") });
}
