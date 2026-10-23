import { z } from "zod";
import { getDb } from "@/lib/db";
import { addNote } from "@/lib/deals/evidence";
import { engineResponse, fail, json, readJson, requireDeal, type RouteCtx } from "@/lib/http";
import { onTrackingSubmitted } from "@/lib/rules/engine";

const body = z.union([
  z.object({
    carrier: z.string().trim().min(1).max(80),
    trackingNumber: z.string().trim().min(3).max(60),
  }),
  z.object({ note: z.string().trim().min(3).max(2000) }),
]);

/** Seller adds tracking (moves the deal to SHIPPED); either party adds a note for a reviewer. */
export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref);
  if (!found.ok) return found.response;
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  if ("note" in input.data) {
    const added = await addNote(getDb(), found.deal.id, found.role, input.data.note);
    return added.ok ? json(added, 201) : fail(409, added.reason);
  }
  if (found.role !== "seller") return fail(403, "only the seller can do this");
  return engineResponse(await onTrackingSubmitted(found.deal.id, input.data));
}
