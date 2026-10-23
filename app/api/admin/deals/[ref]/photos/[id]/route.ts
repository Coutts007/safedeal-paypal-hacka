import { z } from "zod";
import { dealByRef, requireAdmin } from "@/lib/admin/http";
import { getDb } from "@/lib/db";
import { photoFile, photoResponse } from "@/lib/deals/evidence";
import { fail } from "@/lib/http";

type Ctx = { params: Promise<{ ref: string; id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { ref, id } = await params;
  if (!z.uuid().safeParse(id).success) return fail(404, "not found");
  const deal = await dealByRef(ref);
  const file = deal && (await photoFile(getDb(), deal.id, id));
  return file ? photoResponse(file) : fail(404, "not found");
}
