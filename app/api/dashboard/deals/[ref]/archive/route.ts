import { z } from "zod";
import { requireSeller } from "@/lib/accounts/http";
import { setArchived } from "@/lib/accounts/service";
import { getDb } from "@/lib/db";
import { fail, json, readJson, type RouteCtx } from "@/lib/http";

const body = z.object({ archived: z.boolean() });

/** Hide a finished deal from the seller's dashboard lists, or show it again. */
export async function POST(req: Request, { params }: RouteCtx) {
  const seller = await requireSeller(req);
  if (!seller.ok) return seller.response;
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  const ref = (await params).ref;
  if (!/^[0-9A-Z]{6,20}$/.test(ref)) return fail(404, "deal not found");
  const res = await setArchived(getDb(), seller.account, ref, input.data.archived, new Date());
  return res.ok ? json({ ok: true, archived: input.data.archived }) : fail(res.status, res.reason);
}
