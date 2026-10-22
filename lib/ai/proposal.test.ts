import { describe, expect, it } from "vitest";
import { extraction } from "@/tests/ai";
import { carrySourceRefs, sourceRefs, toProposal } from "./proposal";

describe("toProposal", () => {
  it("converts a KES price for the seller to check, and marks it low confidence", () => {
    const p = toProposal(extraction(), 130);
    expect(p.terms.price).toEqual({ amount: "95.00", currency: "USD" });
    expect(p.chatPrice).toEqual({ amount: "12350.00", currency: "KES" });
    expect(p.hints.price).toMatchObject({ confidence: "low", sources: ["m3"] });
    expect(p.hints.price?.note).toContain("KES 12,350");
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
    expect(p.hints.price).toMatchObject({ confidence: "high" });
    expect(p.hints.deliveryMethod).toMatchObject({
      confidence: "low",
      note: "Not settled in the chat.",
    });
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
