import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { deals } from "@/lib/db/schema";
import { serverEnv } from "@/lib/env";
import { fail } from "@/lib/http";
import { cookieFrom, validSession } from "./auth";

/**
 * Admin API guard: ADMIN_PASSWORD set, a valid session cookie, and for POSTs a JSON body (a page
 * on another site cannot send JSON with the admin's cookie without a CORS preflight we never allow).
 */
export function requireAdmin(req: Request) {
  const password = serverEnv().ADMIN_PASSWORD;
  if (!password) return { ok: false as const, response: fail(503, "ADMIN_PASSWORD is not set") };
  if (!validSession(cookieFrom(req.headers.get("cookie")), password, new Date())) {
    return { ok: false as const, response: fail(401, "log in as admin first") };
  }
  if (req.method === "POST" && !req.headers.get("content-type")?.startsWith("application/json")) {
    return { ok: false as const, response: fail(415, "send JSON") };
  }
  return { ok: true as const };
}

export async function dealByRef(ref: string) {
  if (!/^[0-9A-Z]{6,20}$/.test(ref)) return null;
  const [deal] = await getDb().select().from(deals).where(eq(deals.publicRef, ref));
  return deal ?? null;
}
