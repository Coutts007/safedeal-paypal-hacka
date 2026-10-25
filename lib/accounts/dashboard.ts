import type { DealState } from "@/lib/db/schema";
import type { DealView } from "@/lib/deals/service";
import { HELD_STATES } from "@/lib/rules/machine";

// The seller's dashboard (Phase 6b): which list each deal is in, the one thing to do next, and the
// totals. Pure; built from the same seller view the Deal Room shows, so both always agree.

export type DashboardGroup = "needs" | "active" | "done" | "archived";

/** Finished deals: no money is held and nothing more will happen, short of a PayPal dispute. */
export const FINISHED_STATES: readonly DealState[] = [
  "CAPTURED",
  "CLOSED",
  "VOIDED",
  "EXPIRED",
  "CANCELLED",
];

export const canArchive = (state: DealState) => FINISHED_STATES.includes(state);

export type DashboardRow = {
  ref: string;
  item: string;
  buyer: string | null;
  amount: string | null;
  state: DealState;
  group: DashboardGroup;
  /** Short call to action for Needs you; otherwise what is happening. */
  todo: string;
  statusLine: string;
  /** The next date that matters for this deal, as ISO, with what it is. */
  next: { label: string; at: string } | null;
  updatedAt: string;
};

type View = Pick<
  DealView,
  "ref" | "state" | "statusLine" | "actions" | "terms" | "names" | "amount" | "deadlines"
>;

function todoFor(v: View): string | null {
  const a = new Set(v.actions);
  if (a.has("confirm_terms")) return "Confirm the terms";
  if (a.has("decide_extension")) return "The buyer asked for a new delivery date";
  if (v.state === "AUTHORIZED") {
    return a.has("add_tracking") ? "Paid: ship it and add tracking" : "Hand it over with the code";
  }
  if (v.state === "IN_REVIEW") return "A reviewer is looking at it: add photos or notes";
  if (v.state === "DISPUTED") return "PayPal dispute: download the evidence and upload it";
  return null;
}

function nextDate(v: View): DashboardRow["next"] {
  const d = v.deadlines;
  if (v.state === "AUTHORIZED" && d.shipBy) return { label: "Ship by", at: d.shipBy };
  if (v.state === "SHIPPED" && d.deliverBy) return { label: "Deliver by", at: d.deliverBy };
  if (v.state === "DELIVERED" && d.inspectionEndsAt) {
    return { label: "Paid to you after", at: d.inspectionEndsAt };
  }
  return null;
}

export function dashboardRow(v: View, archivedAt: Date | null, updatedAt: Date): DashboardRow {
  const todo = todoFor(v);
  const finished = FINISHED_STATES.includes(v.state);
  // Archiving hides only finished deals: one that needs the seller again (a dispute) comes back.
  const group: DashboardGroup = finished
    ? archivedAt
      ? "archived"
      : "done"
    : todo
      ? "needs"
      : "active";
  return {
    ref: v.ref,
    item: v.terms?.item ?? "Deal",
    buyer: v.names.buyer,
    amount: v.amount,
    state: v.state,
    group,
    todo: todo ?? v.statusLine,
    statusLine: v.statusLine,
    next: nextDate(v),
    updatedAt: updatedAt.toISOString(),
  };
}

const cents = (amount: string | null) => (amount ? Math.round(Number(amount) * 100) : 0);
const usd = (c: number) => (c / 100).toFixed(2);

/** Money on hold now, and money PayPal has paid out to the seller. */
export function totals(rows: DashboardRow[]) {
  const sum = (states: readonly DealState[]) =>
    usd(rows.filter((r) => states.includes(r.state)).reduce((t, r) => t + cents(r.amount), 0));
  return {
    onHold: sum(HELD_STATES),
    paidOut: sum(["CAPTURED", "CLOSED"]),
    count: rows.length,
  };
}

/** Rows per list, newest activity first; Needs you soonest deadline first. */
export function groupRows<R extends DashboardRow>(rows: R[]) {
  const by = (g: DashboardGroup) => rows.filter((r) => r.group === g);
  const newest = (a: DashboardRow, b: DashboardRow) => b.updatedAt.localeCompare(a.updatedAt);
  const soonest = (a: DashboardRow, b: DashboardRow) =>
    (a.next?.at ?? "9999").localeCompare(b.next?.at ?? "9999") || newest(a, b);
  return {
    needs: by("needs").sort(soonest),
    active: by("active").sort(newest),
    done: by("done").sort(newest),
    archived: by("archived").sort(newest),
  };
}
