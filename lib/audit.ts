import { asc, desc, sql } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db";
import { auditLog, type AuditRow } from "@/lib/db/schema";
import { canonicalJson, sha256Hex } from "@/lib/hash";

// Append-only audit log with one hash chain over all rows:
// hash = sha256(prev_hash + canonical JSON of the row content). Changing, deleting or reordering
// any row breaks every hash after it, which `verifyAuditChain` reports.

export const GENESIS_HASH = "0".repeat(64);

/** Arbitrary constant for the advisory lock that serialises appends to the chain. */
const AUDIT_LOCK_KEY = 7_340_001;

export type AuditEntry = {
  dealId: string | null;
  /** Who acted: "system", "sweep", "buyer", "seller", "admin", "paypal", "courier". */
  actor: string;
  action: string;
  details?: Record<string, unknown>;
};

type HashedContent = {
  dealId: string | null;
  actor: string;
  action: string;
  details: unknown;
  createdAt: Date;
};

export function auditHash(prevHash: string, row: HashedContent): string {
  const content = canonicalJson({
    actor: row.actor,
    action: row.action,
    createdAt: row.createdAt.toISOString(),
    dealId: row.dealId,
    details: row.details,
  });
  return sha256Hex(prevHash + content);
}

/**
 * Append one row. Call inside the transaction that makes the change, so the entry commits or rolls
 * back with it. The advisory lock is held until that transaction ends.
 */
export async function appendAudit(tx: Tx | Db, entry: AuditEntry, now = new Date()) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`);
  const [last] = await tx
    .select({ hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(1);
  const prevHash = last?.hash ?? GENESIS_HASH;
  // Postgres keeps microseconds; JS dates are milliseconds, so the stored value round-trips.
  const createdAt = new Date(now.getTime());
  const details = entry.details ?? {};
  const hash = auditHash(prevHash, { ...entry, details, createdAt });
  const [row] = await tx
    .insert(auditLog)
    .values({
      dealId: entry.dealId,
      actor: entry.actor,
      action: entry.action,
      detailsJson: details,
      prevHash,
      hash,
      createdAt,
    })
    .returning();
  return row;
}

export type ChainCheck =
  { ok: true; rows: number } | { ok: false; rows: number; badId: number; reason: string };

/** Recompute the whole chain in id order. Reports the first row that does not match. */
export async function verifyAuditChain(db: Db | Tx): Promise<ChainCheck> {
  const rows: AuditRow[] = await db.select().from(auditLog).orderBy(asc(auditLog.id));
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prevHash !== prev) {
      return {
        ok: false,
        rows: rows.length,
        badId: r.id,
        reason: "prev_hash does not match the previous row",
      };
    }
    const expected = auditHash(prev, {
      dealId: r.dealId,
      actor: r.actor,
      action: r.action,
      details: r.detailsJson,
      createdAt: r.createdAt,
    });
    if (expected !== r.hash) {
      return {
        ok: false,
        rows: rows.length,
        badId: r.id,
        reason: "hash does not match the row content",
      };
    }
    prev = r.hash;
  }
  return { ok: true, rows: rows.length };
}
