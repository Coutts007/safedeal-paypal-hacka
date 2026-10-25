import { describe, expect, it } from "vitest";
import { extraction } from "@/tests/ai";
import { carrySourceRefs, proposalSummary, sourceRefs, toProposal } from "./proposal";

describe("toProposal", () => {
  it("converts a KES price for the seller to confirm, keeping the AI's own confidence", () => {
    const p = toProposal(extraction(), 130);
    expect(p.terms.price).toEqual({ amount: "95.00", currency: "USD" });
    expect(p.chatPrice).toEqual({ amount: "12350.00", currency: "KES" });
    // Read correctly from the chat, so not shown as the AI being unsure; the seller confirms
    // the US$ amount because SafeDeal converted it.
    expect(p.hints.price).toMatchObject({ confidence: "high", action: "set_usd", sources: ["m3"] });
    expect(p.hints.price?.note).toBe(
      "The chat says KES 12,350. That is about US$95.00 at 130 KES per US$. PayPal charges in US$, so confirm the amount.",
    );
    expect(p.terms).toMatchObject({
      item: "Samsung Galaxy A15",
      deliveryMethod: "courier",
      carrier: "G4S",
      shipBy: "2026-11-03T18:00:00+03:00",
      deliverBy: null,
      conditions: ["Screen has no cracks"],
      payeeEmail: "",
    });
  });

  it("keeps a USD price and leaves unknown fields for the seller", () => {
    const p = toProposal(
      extraction({
        price: { amount: "95", currency: "USD", sources: ["m3"], confidence: "high" },
        delivery_method: { value: null, sources: [], confidence: "low" },
      }),
      130,
    );
    expect(p.terms.price.amount).toBe("95.00");
    expect(p.hints.price).toEqual({ sources: ["m3"], confidence: "high" });
    expect(p.hints.deliveryMethod).toMatchObject({ action: "fill_in", sources: [] });
  });
});

describe("proposalSummary", () => {
  it("counts the fields read from the chat and names what needs the seller", () => {
    const p = toProposal(
      extraction({
        delivery_method: { value: null, sources: [], confidence: "low" },
        ship_by: { value: "2026-11-03T18:00:00+03:00", sources: ["m4"], confidence: "medium" },
        missing_fields: ["delivery_method", "deliver_by"],
      }),
      130,
    );
    expect(proposalSummary(p)).toEqual({
      filled: 5, // item, quantity, price, carrier, ship-by
      needsYou: ["confirm the US$ price (the chat was in KES)", "choose the delivery method"],
      check: ["ship-by date"],
      notMentioned: ["deliver-by date"],
    });
  });

  it("asks for nothing when every field was read clearly in US$", () => {
    const p = toProposal(
      extraction({
        price: { amount: "95", currency: "USD", sources: ["m3"], confidence: "high" },
        ship_by: { value: "2026-11-03T18:00:00+03:00", sources: ["m4"], confidence: "high" },
        missing_fields: [],
      }),
      130,
    );
    expect(proposalSummary(p)).toMatchObject({ needsYou: [], check: [], notMentioned: [] });
  });
});

describe("sourceRefs and carrySourceRefs", () => {
  it("records which fields the seller changed; changed fields stop citing the chat", () => {
    const p = toProposal(extraction(), 130);
    const final = {
      ...p.terms,
      price: { amount: "90.00", currency: "USD" as const },
      payeeEmail: "s@x.com",
    };
    const refs = sourceRefs(p, final);
    expect(refs.fields.item).toMatchObject({ edited: false, sources: ["m2"] });
    expect(refs.fields.price).toMatchObject({ edited: true, sources: [] });
    expect(refs.conditions).toEqual([{ text: "Screen has no cracks", sources: ["m3"] }]);

    const next = {
      ...final,
      item: "Samsung A15 128GB",
      conditions: ["Screen has no cracks", "Box"],
    };
    const carried = carrySourceRefs(refs, final, next);
    expect(carried?.fields.item).toMatchObject({ edited: true, sources: [] });
    expect(carried?.fields.carrier).toMatchObject({ edited: false, sources: ["m4"] });
    expect(carried?.conditions).toEqual([
      { text: "Screen has no cracks", sources: ["m3"] },
      { text: "Box", sources: [] },
    ]);
    expect(carrySourceRefs({}, final, next)).toBeNull();
  });
});
