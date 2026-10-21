import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "@/tests/db";
import { appendAudit, GENESIS_HASH, verifyAuditChain } from "./audit";

const { db, close } = testDb();
afterAll(close);
beforeEach(() => resetDb(db));

async function appendThree() {
  for (const action of ["deal.created", "terms.confirmed", "deal.agreed"]) {
    await appendAudit(db, {
      dealId: null,
      actor: "system",
      action,
      details: { n: action.length, z: 1, a: [1, 2] },
    });
  }
}

describe("audit log hash chain", () => {
  it("links each row to the previous one and verifies", async () => {
    await appendThree();
    const rows = await db.execute<{ prev_hash: string; hash: string }>(
      sql`SELECT prev_hash, hash FROM audit_log ORDER BY id`,
    );
    expect(rows.rows[0].prev_hash).toBe(GENESIS_HASH);
    expect(rows.rows[1].prev_hash).toBe(rows.rows[0].hash);
    expect(await verifyAuditChain(db)).toEqual({ ok: true, rows: 3 });
  });

  it("refuses UPDATE and DELETE", async () => {
    await appendThree();
    await expect(db.execute(sql`UPDATE audit_log SET actor = 'x' WHERE id = 1`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM audit_log WHERE id = 1`)).rejects.toThrow();
  });

  it("detects a changed row even when the trigger is bypassed", async () => {
    await appendThree();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`UPDATE audit_log SET details_json = '{"n": 999}' WHERE id = 2`);
    });
    expect(await verifyAuditChain(db)).toMatchObject({
      ok: false,
      badId: 2,
      reason: "hash does not match the row content",
    });
  });

  it("detects a deleted row", async () => {
    await appendThree();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM audit_log WHERE id = 2`);
    });
    expect(await verifyAuditChain(db)).toMatchObject({
      ok: false,
      badId: 3,
      reason: "prev_hash does not match the previous row",
    });
  });

  it("keeps one unbroken chain under concurrent appends", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.transaction((tx) => appendAudit(tx, { dealId: null, actor: "system", action: `a${i}` })),
      ),
    );
    expect(await verifyAuditChain(db)).toEqual({ ok: true, rows: 10 });
  });
});
