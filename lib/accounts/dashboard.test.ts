import { describe, expect, it } from "vitest";
import type { DealAction } from "@/lib/deals/service";
import type { DealState } from "@/lib/db/schema";
import { canArchive, dashboardRow, groupRows, totals } from "./dashboard";

const view = (state: DealState, actions: DealAction[] = [], over: object = {}) => ({
  ref: `REF${state}`,
  state,
  statusLine: `status for ${state}`,
  actions,
  terms: { item: "Samsung A15" } as never,
  names: { seller: "David", buyer: "Shemaya" },
  amount: "95.00",
  deadlines: {
    shipBy: "2026-10-27T15:00:00.000Z",
    deliverBy: "2026-11-01T15:00:00.000Z",
    inspectionEndsAt: null,
    reviewAt: null,
    holdEndsAt: null,
  },
  ...over,
});
const at = new Date("2026-10-25T10:00:00Z");
const row = (state: DealState, actions: DealAction[] = [], archivedAt: Date | null = null) =>
  dashboardRow(view(state, actions), archivedAt, at);

describe("dashboard rows", () => {
  it("puts what the seller must do in Needs you, with a plain call to action", () => {
    expect(row("DRAFT", ["confirm_terms", "edit_terms"])).toMatchObject({
      group: "needs",
      todo: "Confirm the terms",
    });
    expect(row("AUTHORIZED", ["add_tracking"])).toMatchObject({
      group: "needs",
      todo: "Paid: ship it and add tracking",
      next: { label: "Ship by", at: "2026-10-27T15:00:00.000Z" },
    });
    expect(row("IN_REVIEW").group).toBe("needs");
    expect(row("DISPUTED").todo).toMatch(/download the evidence/);
  });

  it("shows waiting deals as In progress with the Deal Room's status line", () => {
    expect(row("DRAFT", ["edit_terms"])).toMatchObject({
      group: "active",
      todo: "status for DRAFT",
    });
    expect(row("AGREED").group).toBe("active");
    expect(row("SHIPPED")).toMatchObject({ group: "active", next: { label: "Deliver by" } });
    expect(row("FUNDING_FAILED").group).toBe("active");
  });

  it("archives only finished deals, and a disputed deal is back in Needs you even if archived", () => {
    for (const s of ["CAPTURED", "CLOSED", "VOIDED", "EXPIRED", "CANCELLED"] as const) {
      expect(canArchive(s)).toBe(true);
      expect(row(s).group).toBe("done");
      expect(row(s, [], at).group).toBe("archived");
    }
    for (const s of ["DRAFT", "AUTHORIZED", "SHIPPED", "DISPUTED", "IN_REVIEW"] as const) {
      expect(canArchive(s)).toBe(false);
    }
    expect(row("DISPUTED", [], at).group).toBe("needs");
  });

  it("totals money on hold and paid out in exact cents", () => {
    const rows = [
      dashboardRow(view("AUTHORIZED", [], { amount: "0.10" }), null, at),
      dashboardRow(view("SHIPPED", [], { amount: "0.20" }), null, at),
      dashboardRow(view("CAPTURED", [], { amount: "95.00" }), at, at),
      dashboardRow(view("VOIDED", [], { amount: "40.00" }), null, at),
    ];
    expect(totals(rows)).toEqual({ onHold: "0.30", paidOut: "95.00", count: 4 });
  });

  it("sorts Needs you by the soonest deadline", () => {
    const soon = dashboardRow(
      view("AUTHORIZED", ["add_tracking"], {
        ref: "SOON",
        deadlines: { ...view("AUTHORIZED").deadlines, shipBy: "2026-10-26T00:00:00.000Z" },
      }),
      null,
      at,
    );
    const later = row("AUTHORIZED", ["add_tracking"]);
    const draft = row("DRAFT", ["confirm_terms"]);
    expect(groupRows([draft, later, soon]).needs.map((r) => r.ref)).toEqual([
      "SOON",
      "REFAUTHORIZED",
      "REFDRAFT",
    ]);
  });
});
