import { z } from "zod";
import type { Extraction } from "./schema";

// Field-level scoring for `npm run eval` (BUILD_PLAN Phase 4). For each field: a correct value is
// a true positive; a wrong value counts as both a false positive and a false negative; a missing
// value is a false negative; a value where the gold label is null is a false positive.

export const goldChatSchema = z.object({
  id: z.string(),
  language_mix: z.enum(["english", "swahili", "sheng", "mixed"]),
  chat_date: z.iso.date(),
  chat: z.string().min(1),
  gold: z.object({
    item: z.string().nullable(),
    quantity: z.number().int().nullable(),
    price: z.object({ amount: z.string(), currency: z.enum(["KES", "USD", "OTHER"]) }).nullable(),
    delivery_method: z.enum(["courier", "rider", "pickup", "post", "other"]).nullable(),
    carrier: z.string().nullable(),
    ship_by: z.iso.date().nullable(),
    deliver_by: z.iso.date().nullable(),
    conditions: z.array(z.string()),
  }),
  expect_flag: z.boolean(),
  notes: z.string().optional(),
  example: z.boolean().optional(),
});
export type GoldChat = z.infer<typeof goldChatSchema>;

export const SCORED_FIELDS = [
  "item",
  "quantity",
  "price",
  "delivery_method",
  "carrier",
  "ship_by",
  "deliver_by",
  "conditions",
] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];

export type Counts = { tp: number; fp: number; fn: number };
export type ChatScore = { fields: Record<ScoredField, Counts>; flagCorrect: boolean };

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter(Boolean),
  );

/** Share of the gold words found in the prediction (wording may differ slightly). */
function overlap(gold: string, pred: string): number {
  const g = words(gold);
  const p = words(pred);
  if (!g.size) return 0;
  let hit = 0;
  for (const w of g) if (p.has(w)) hit++;
  return hit / g.size;
}

const NAIROBI_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" });
const day = (iso: string | null) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : NAIROBI_DAY.format(new Date(t));
};

function scalar<T>(gold: T | null, pred: T | null, same: (g: T, p: T) => boolean): Counts {
  if (gold === null && pred === null) return { tp: 0, fp: 0, fn: 0 };
  if (gold === null) return { tp: 0, fp: 1, fn: 0 };
  if (pred === null) return { tp: 0, fp: 0, fn: 1 };
  return same(gold, pred) ? { tp: 1, fp: 0, fn: 0 } : { tp: 0, fp: 1, fn: 1 };
}

/** Conditions are matched one to one: each gold condition to its closest unused prediction. */
function conditions(gold: string[], pred: string[]): Counts {
  const unused = [...pred];
  let tp = 0;
  for (const g of gold) {
    let best = -1;
    let bestScore = 0.5;
    unused.forEach((p, i) => {
      const s = Math.max(overlap(g, p), overlap(p, g));
      if (s >= bestScore) {
        best = i;
        bestScore = s;
      }
    });
    if (best >= 0) {
      tp++;
      unused.splice(best, 1);
    }
  }
  return { tp, fp: unused.length, fn: gold.length - tp };
}

/** `pred` null means the AI produced nothing usable: every gold value counts as missed. */
export function scoreChat(gold: GoldChat, pred: Extraction | null): ChatScore {
  const g = gold.gold;
  const p = pred;
  const fields: ChatScore["fields"] = {
    item: scalar(
      g.item,
      p?.item.value ?? null,
      (a, b) => overlap(a, b) >= 0.6 || overlap(b, a) >= 0.8,
    ),
    quantity: scalar(g.quantity, p?.quantity.value ?? null, (a, b) => a === b),
    price: scalar(
      g.price,
      p?.price.amount != null && p.price.currency
        ? { amount: p.price.amount, currency: p.price.currency }
        : null,
      (a, b) => a.currency === b.currency && Math.abs(Number(a.amount) - Number(b.amount)) < 0.01,
    ),
    delivery_method: scalar(g.delivery_method, p?.delivery_method.value ?? null, (a, b) => a === b),
    carrier: scalar(g.carrier, p?.carrier.value ?? null, (a, b) => {
      const x = a.toLowerCase().trim();
      const y = b.toLowerCase().trim();
      return x.includes(y) || y.includes(x);
    }),
    ship_by: scalar(g.ship_by, day(p?.ship_by.value ?? null), (a, b) => a === b),
    deliver_by: scalar(g.deliver_by, day(p?.deliver_by.value ?? null), (a, b) => a === b),
    conditions: conditions(g.conditions, p?.conditions.map((c) => c.text) ?? []),
  };
  const flagged = (p?.instruction_flags.length ?? 0) > 0;
  return { fields, flagCorrect: flagged === gold.expect_flag };
}

export type Metrics = Counts & { precision: number; recall: number; f1: number };

export function metrics(c: Counts): Metrics {
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 1;
  const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { ...c, precision, recall, f1 };
}

export const add = (a: Counts, b: Counts): Counts => ({
  tp: a.tp + b.tp,
  fp: a.fp + b.fp,
  fn: a.fn + b.fn,
});
export const ZERO: Counts = { tp: 0, fp: 0, fn: 0 };
