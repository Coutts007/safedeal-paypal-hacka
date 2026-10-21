import { z } from "zod";
import { engineResponse, readJson, requireDeal, type RouteCtx } from "@/lib/http";
import { onTermsConfirmed } from "@/lib/rules/engine";

/** Confirm the terms the party was shown, identified by their hash. */
export async function POST(req: Request, { params }: RouteCtx) {
  const found = await requireDeal(req, (await params).ref);
  if (!found.ok) return found.response;
  const input = await readJson(req, z.object({ termsHash: z.string().regex(/^[0-9a-f]{64}$/) }));
  if (!input.ok) return input.response;
  return engineResponse(
    await onTermsConfirmed(found.deal.id, { role: found.role, termsHash: input.data.termsHash }),
  );
}
