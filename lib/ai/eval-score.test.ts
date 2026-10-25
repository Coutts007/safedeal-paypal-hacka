import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extraction } from "@/tests/ai";
import { calibration, goldChatSchema, metrics, scoreChat, type GoldChat } from "./eval-score";

const gold: GoldChat = {
  id: "t-1",
  language_mix: "english",
  chat_date: "2026-11-02",
  chat: "x",
  gold: {
    item: "Samsung Galaxy A15",
    quantity: 1,
    price: { amount: "12350.00", currency: "KES" },
    delivery_method: "courier",
    carrier: "G4S",
    ship_by: "2026-11-03",
    deliver_by: null,
    conditions: ["Screen has no cracks", "Comes with charger"],
  },
  expect_flag: false,
};

describe("scoreChat", () => {
  it("scores matching values as true positives, with tolerant wording and dates by Nairobi day", () => {
    const s = scoreChat(
      gold,
      extraction({ item: { value: "Galaxy A15 by Samsung", sources: [], confidence: "high" } }),
    );
    expect(s.fields.item).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(s.fields.ship_by).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(s.fields.deliver_by).toEqual({ tp: 0, fp: 0, fn: 0 });
    expect(s.fields.conditions).toEqual({ tp: 1, fp: 0, fn: 1 });
    expect(s.flagCorrect).toBe(true);
  });

  it("counts a wrong value as a false positive and a false negative, and a miss as a false negative", () => {
    const s = scoreChat(
      gold,
      extraction({
        price: { amount: "12000.00", currency: "KES", sources: [], confidence: "high" },
        carrier: { value: null, sources: [], confidence: "low" },
        deliver_by: { value: "2026-11-05T18:00:00+03:00", sources: [], confidence: "low" },
      }),
    );
    expect(s.fields.price).toEqual({ tp: 0, fp: 1, fn: 1 });
    expect(s.fields.carrier).toEqual({ tp: 0, fp: 0, fn: 1 });
    expect(s.fields.deliver_by).toEqual({ tp: 0, fp: 1, fn: 0 });
  });

  it("scores no answer as all misses", () => {
    expect(scoreChat(gold, null).fields.price).toEqual({ tp: 0, fp: 0, fn: 1 });
  });

  it("computes precision, recall and F1", () => {
    expect(metrics({ tp: 3, fp: 1, fn: 2 })).toMatchObject({ precision: 0.75, recall: 0.6 });
  });
});

describe("calibration", () => {
  it("counts filled fields per confidence level and how many were right", () => {
    // Fixture: ship_by "medium" and right; carrier made "low" and wrong; deliver_by not filled.
    const prediction = extraction({
      carrier: { value: "Fargo", sources: ["m4"], confidence: "low" },
    });
    const c = calibration([{ prediction, score: scoreChat(gold, prediction) }]);
    expect(c.medium).toEqual({ filled: 1, right: 1 });
    expect(c.low).toEqual({ filled: 1, right: 0 });
    expect(c.high.filled).toBe(4); // item, quantity, price, delivery method
    expect(calibration([{ prediction: null, score: scoreChat(gold, null) }]).high.filled).toBe(0);
  });
});

describe("eval/chats", () => {
  it("every labelled chat file matches the format", () => {
    const files = readdirSync("eval/chats").filter(
      (f) => f.endsWith(".json") && f !== "TEMPLATE.json",
    );
    expect(files.length).toBeGreaterThanOrEqual(40);
    for (const f of files) {
      const parsed = goldChatSchema.safeParse(JSON.parse(readFileSync(`eval/chats/${f}`, "utf8")));
      expect(parsed.success, `${f}: ${parsed.error?.message}`).toBe(true);
    }
  });
});
