import { engineResponse, requireDeal, type RouteCtx } from "@/lib/http";
import { onCancel } from "@/lib/rules/engine";

export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref);
  if (!found.ok) return found.response;
  return engineResponse(await onCancel(found.deal.id, found.role));
}
