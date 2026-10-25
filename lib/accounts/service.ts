import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { appendAudit } from "@/lib/audit";
import type { Db } from "@/lib/db";
import { accounts, deals, dealTerms, type Account } from "@/lib/db/schema";
import { dealView } from "@/lib/deals/service";
import type { PaypalProfile } from "@/lib/paypal/identity";
import { canArchive, dashboardRow, groupRows, totals } from "./dashboard";
import { sessionAccountId } from "./session";

// Seller accounts (Phase 6b). Accounts never touch money: deals still move only through the rule
// engine, and the dashboard only reads deals and hides finished ones.

/**
 * After Log in with PayPal: create or refresh the account, then add the seller's earlier link-only
 * deals that pay out to this verified PayPal email (it is their money either way).
 */
export async function loginAccount(db: Db, profile: PaypalProfile, now: Date) {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({ ...profile, lastLoginAt: now })
      .onConflictDoUpdate({
        target: accounts.paypalUserId,
        set: {
          email: profile.email,
          name: profile.name,
          payerId: profile.payerId,
          verifiedAccount: profile.verifiedAccount,
          lastLoginAt: now,
        },
      })
      .returning();
    // The payout email is on the deal once agreed, and in the seller's first terms before that.
    const claimed = await tx
      .update(deals)
      .set({ sellerAccountId: account.id })
      .where(
        and(
          isNull(deals.sellerAccountId),
          sql`(lower(${deals.payeeEmail}) = ${profile.email} or exists (
            select 1 from ${dealTerms} where ${dealTerms.dealId} = ${deals.id}
              and ${dealTerms.version} = 1
              and lower(${dealTerms.termsJson}->>'payeeEmail') = ${profile.email}))`,
        ),
      )
      .returning({ id: deals.id });
    for (const d of claimed) {
      await appendAudit(
        tx,
        {
          dealId: d.id,
          actor: "seller",
          action: "account.linked",
          details: { by: "payout email" },
        },
        now,
      );
    }
    return { account, claimed: claimed.length };
  });
}

/** The logged-in seller's account for a session cookie value, or null. */
export async function sessionAccount(
  db: Db,
  cookie: string | null | undefined,
  key: string,
  now: Date,
): Promise<Account | null> {
  const id = sessionAccountId(cookie, key, now);
  if (!id) return null;
  const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
  return account ?? null;
}

/** Every deal of the account, sorted into the dashboard lists, with totals. */
export async function dashboard(
  db: Db,
  account: Account,
  opts: { now: Date; timeScale: number; kesPerUsd: number; appBaseUrl: string },
) {
  const own = await db
    .select()
    .from(deals)
    .where(eq(deals.sellerAccountId, account.id))
    .orderBy(desc(deals.updatedAt));
  const rows = [];
  for (const deal of own) {
    const view = await dealView(db, deal, "seller", opts);
    rows.push({
      ...dashboardRow(view, deal.archivedAt, deal.updatedAt),
      // The Deal Room as the seller; the dashboard is the seller's own page.
      path: `/deal/${deal.publicRef}?t=${encodeURIComponent(deal.sellerToken)}`,
    });
  }
  return { lists: groupRows(rows), totals: totals(rows) };
}

export type Dashboard = Awaited<ReturnType<typeof dashboard>>;
export type DashboardDeal = Dashboard["lists"]["needs"][number];

/** Hide a finished deal from the lists, or show it again. Never changes the deal itself. */
export async function setArchived(
  db: Db,
  account: Account,
  ref: string,
  archived: boolean,
  now: Date,
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  return db.transaction(async (tx) => {
    const [deal] = await tx
      .select()
      .from(deals)
      .where(and(eq(deals.publicRef, ref), eq(deals.sellerAccountId, account.id)))
      .for("no key update");
    // Another seller's deal answers like a missing one, so refs cannot be probed.
    if (!deal) return { ok: false, status: 404, reason: "deal not found" };
    if (archived && !canArchive(deal.state)) {
      return { ok: false, status: 409, reason: "only finished deals can be archived" };
    }
    if (Boolean(deal.archivedAt) === archived) return { ok: true };
    await tx
      .update(deals)
      .set({ archivedAt: archived ? now : null })
      .where(eq(deals.id, deal.id));
    await appendAudit(
      tx,
      { dealId: deal.id, actor: "seller", action: archived ? "deal.archived" : "deal.unarchived" },
      now,
    );
    return { ok: true };
  });
}
