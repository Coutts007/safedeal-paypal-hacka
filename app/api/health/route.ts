import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Render health check: the app is up and the database answers. */
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return json({ ok: true, db: "ok" });
  } catch {
    return json({ ok: false, db: "unreachable" }, 503);
  }
}
