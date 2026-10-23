import { z } from "zod";
import { engineResponse, readJson, requireDeal, type RouteCtx } from "@/lib/http";
import { onExtensionDecided, onExtensionProposed } from "@/lib/rules/engine";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose"), newDeliverBy: z.iso.datetime({ offset: true }) }),
  z.object({ action: z.enum(["accept", "reject"]), extensionId: z.uuid() }),
]);

/** Extend delivery date: either party proposes, the other accepts or rejects (section 7.1). */
export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref);
  if (!found.ok) return found.response;
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  const d = input.data;
  const result =
    d.action === "propose"
      ? await onExtensionProposed(found.deal.id, {
          role: found.role,
          newDeliverBy: new Date(d.newDeliverBy),
        })
      : await onExtensionDecided(found.deal.id, {
          role: found.role,
          extensionId: d.extensionId,
          accept: d.action === "accept",
        });
  return engineResponse(result);
}
