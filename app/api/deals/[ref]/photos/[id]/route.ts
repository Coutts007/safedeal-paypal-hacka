import { z } from "zod";
import { getDb } from "@/lib/db";
import { photoFile, photoResponse } from "@/lib/deals/evidence";
import { dealForToken } from "@/lib/deals/service";
import { fail } from "@/lib/http";

type Ctx = { params: Promise<{ ref: string; id: string }> };

/**
 * A photo of the deal, for either party. An <img> cannot send headers, so the party's token may
 * come in `?t=` like the Deal Room link itself (the page sets no-referrer).
 */
export async function GET(req: Request, { params }: Ctx) {
  const { ref, id } = await params;
  if (!z.uuid().safeParse(id).success) return fail(404, "not found");
  const token = req.headers.get("x-deal-token") ?? new URL(req.url).searchParams.get("t");
  const db = getDb();
  const found = await dealForToken(db, ref, token);
  if (!found) return fail(404, "not found");
  const file = await photoFile(db, found.deal.id, id);
  return file ? photoResponse(file) : fail(404, "not found");
}
