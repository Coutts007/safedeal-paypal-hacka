import { describe, expect, it } from "vitest";
import { parseDealTerms, termsHash, type DealTerms } from "./terms";

const base = {
  item: "Samsung Galaxy A15, used",
  quantity: 1,
  price: { amount: "95.00", currency: "USD" },
  deliveryMethod: "courier",
  carrier: "G4S",
  shipBy: null,
  deliverBy: null,
  conditions: ["Screen has no cracks"],
  payeeEmail: "Seller@Example.com",
};

describe("parseDealTerms", () => {
  it("accepts valid terms, lowercases the payee and fills defaults", () => {
    const t = parseDealTerms(base, 500);
    expect(t.payeeEmail).toBe("seller@example.com");
    expect(t.inspectionHours).toBe(48);
  });

  it.each([
    ["a float amount", { price: { amount: 95, currency: "USD" } }],
    ["three decimals", { price: { amount: "95.001", currency: "USD" } }],
    ["zero", { price: { amount: "0.00", currency: "USD" } }],
    ["KES", { price: { amount: "95.00", currency: "KES" } }],
    ["a bad email", { payeeEmail: "not-an-email" }],
    ["an empty item", { item: "  " }],
  ])("rejects %s", (_, patch) => {
    expect(() => parseDealTerms({ ...base, ...patch }, 500)).toThrow();
  });

  it("enforces the cap", () => {
    expect(() =>
      parseDealTerms({ ...base, price: { amount: "500.01", currency: "USD" } }, 500),
    ).toThrow("above the 500 USD cap");
    expect(
      parseDealTerms({ ...base, price: { amount: "500.00", currency: "USD" } }, 500).price.amount,
    ).toBe("500.00");
  });
});

describe("termsHash", () => {
  it("is stable across key order and changes with any field", () => {
    const t = parseDealTerms(base, 500);
    const reordered = Object.fromEntries(Object.entries(t).reverse()) as DealTerms;
    expect(termsHash(reordered)).toBe(termsHash(t));
    expect(termsHash({ ...t, price: { amount: "96.00", currency: "USD" } })).not.toBe(termsHash(t));
  });
});
