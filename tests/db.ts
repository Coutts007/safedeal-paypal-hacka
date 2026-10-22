import { sql } from "drizzle-orm";
import { connect, type Db } from "@/lib/db";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://safedeal:safedeal@localhost:5433/safedeal_test";

export function testDb(): { db: Db; close: () => Promise<void> } {
  return connect(TEST_DATABASE_URL);
}

/** Empty every table. Bypasses the audit_log append-only trigger (needs a superuser, as in Docker and CI). */
export async function resetDb(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`
      TRUNCATE audit_log, reviews, webhook_events, courier_events, evidence, payment_requests, ai_runs,
        ai_extractions, extensions,
        payments, confirmations, deal_terms, chat_sources, deals RESTART IDENTITY CASCADE`);
  });
}
