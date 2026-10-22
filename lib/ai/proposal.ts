import type { Extraction } from "./schema";

// Turns the AI's extraction into a pre-filled deal form plus a marker per field (where it came
// from, how sure the AI was). Pure and browser-safe: the create page and the server both use it,
// the server to record which fields the seller changed.

export type Confidence = "high" | "medium" | "low";
export type FieldHint = { sources: string[]; confidence: Confidence; note?: string };

export type HintedField =
  "item" | "quantity" | "price" | "deliveryMethod" | "carrier" | "shipBy" | "deliverBy";

export type ProposedTerms = {
  item: string;
  quantity: number;
  price: { amount: string; currency: "USD" };
  deliveryMethod: "courier" | "rider" | "pickup" | "post" | "other";
  carrier: string | null;
  shipBy: string | null;
  deliverBy: string | null;
  inspectionHours: number;
  conditions: string[];
  payeeEmail: string;
};

export type Proposal = {
  terms: ProposedTerms;
  hints: Partial<Record<HintedField, FieldHint>>;
  conditionSources: string[][];
  /** Price as written in the chat, when it was not in USD. */
  chatPrice: { amount: string; currency: "KES" | "OTHER" } | null;
  missing: string[];
  notes: string;
  flags: { messageId: string; reason: string }[];
  languageMix: Extraction["language_mix"];
};

const hint = (f: { sources: string[]; confidence: Confidence }, note?: string): FieldHint => ({
  sources: f.sources,
  confidence: f.confidence,
  ...(note && { note }),
});

export function toProposal(x: Extraction, kesPerUsd: number): Proposal {
  const hints: Proposal["hints"] = {};
  let amount = "";
  let chatPrice: Proposal["chatPrice"] = null;
  if (x.price.amount !== null && x.price.currency) {
    const n = Number(x.price.amount);
    if (x.price.currency === "USD") {
      amount = n.toFixed(2);
      hints.price = hint(x.price);
    } else {
      chatPrice = { amount: n.toFixed(2), currency: x.price.currency };
      if (x.price.currency === "KES") amount = (n / kesPerUsd).toFixed(2);
      hints.price = {
        sources: x.price.sources,
        // A converted price is always for the seller to check: PayPal charges USD.
        confidence: "low",
        note:
          x.price.currency === "KES"
            ? `Chat says KES ${n.toLocaleString("en-KE")}; converted at ${kesPerUsd} KES per US$. Set the USD price.`
            : "The chat price is not in KES or USD. Set the USD price.",
      };
    }
  } else {
    hints.price = { sources: [], confidence: "low", note: "No agreed price found in the chat." };
  }

  if (x.item.value) hints.item = hint(x.item);
  if (x.quantity.value) hints.quantity = hint(x.quantity);
  hints.deliveryMethod = x.delivery_method.value
    ? hint(x.delivery_method)
    : { sources: [], confidence: "low", note: "Not settled in the chat." };
  if (x.carrier.value) hints.carrier = hint(x.carrier);
  if (x.ship_by.value) hints.shipBy = hint(x.ship_by);
  if (x.deliver_by.value) hints.deliverBy = hint(x.deliver_by);

  return {
    terms: {
      item: x.item.value?.trim().slice(0, 127) ?? "",
      quantity: x.quantity.value ?? 1,
      price: { amount, currency: "USD" },
      deliveryMethod: x.delivery_method.value ?? "courier",
      carrier: x.carrier.value?.trim().slice(0, 80) || null,
      shipBy: x.ship_by.value,
      deliverBy: x.deliver_by.value,
      inspectionHours: 48,
      conditions: x.conditions.map((c) => c.text.trim().slice(0, 280)).filter(Boolean),
      payeeEmail: "",
    },
    hints,
    conditionSources: x.conditions.map((c) => c.sources),
    chatPrice,
    missing: x.missing_fields,
    notes: x.notes_for_humans,
    flags: x.instruction_flags.map((f) => ({ messageId: f.message_id, reason: f.reason })),
    languageMix: x.language_mix,
  };
}

const FIELD_VALUE: Record<HintedField, (t: ProposedTerms) => unknown> = {
  item: (t) => t.item.trim().toLowerCase(),
  quantity: (t) => t.quantity,
  price: (t) => Number(t.price.amount),
  deliveryMethod: (t) => t.deliveryMethod,
  carrier: (t) => t.carrier?.trim().toLowerCase() ?? null,
  shipBy: (t) => (t.shipBy ? Date.parse(t.shipBy) : null),
  deliverBy: (t) => (t.deliverBy ? Date.parse(t.deliverBy) : null),
};

/**
 * Source references stored with the terms: for each field the AI filled, its sources and
 * confidence, and whether the person changed it (a changed field no longer cites the chat).
 */
export function sourceRefs(proposal: Proposal, final: ProposedTerms) {
  const fields: Partial<Record<HintedField, FieldHint & { edited: boolean }>> = {};
  for (const [k, h] of Object.entries(proposal.hints) as [HintedField, FieldHint][]) {
    const edited = FIELD_VALUE[k](proposal.terms) !== FIELD_VALUE[k](final);
    fields[k] = { ...h, edited, sources: edited ? [] : h.sources };
  }
  const conditions = final.conditions.map((text) => {
    const i = proposal.terms.conditions.indexOf(text);
    return { text, sources: i >= 0 ? (proposal.conditionSources[i] ?? []) : [] };
  });
  return { fields, conditions };
}

export type SourceRefs = ReturnType<typeof sourceRefs>;

/**
 * Source references for a new terms version: a field keeps its chat sources only while its value
 * is unchanged from the previous version.
 */
export function carrySourceRefs(
  previous: unknown,
  prevTerms: ProposedTerms,
  next: ProposedTerms,
): SourceRefs | null {
  const prev = previous as Partial<SourceRefs> | null;
  if (!prev?.fields) return null;
  const fields: SourceRefs["fields"] = {};
  for (const [k, h] of Object.entries(prev.fields) as [
    HintedField,
    SourceRefs["fields"][HintedField],
  ][]) {
    if (!h) continue;
    const changed = FIELD_VALUE[k](prevTerms) !== FIELD_VALUE[k](next);
    fields[k] = changed ? { ...h, edited: true, sources: [] } : h;
  }
  const conditions = next.conditions.map((text) => ({
    text,
    sources: prev.conditions?.find((c) => c.text === text)?.sources ?? [],
  }));
  return { fields, conditions };
}
