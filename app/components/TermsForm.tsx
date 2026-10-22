"use client";

import { useState } from "react";
import type { ChatMessage } from "@/lib/ai/chat";
import type { FieldHint, HintedField } from "@/lib/ai/proposal";
import { SourceChips } from "./Sources";
import { Button, Field, inputClass } from "./ui";

export type TermsInput = {
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

export const EMPTY_TERMS: TermsInput = {
  item: "",
  quantity: 1,
  price: { amount: "", currency: "USD" },
  deliveryMethod: "courier",
  carrier: null,
  shipBy: null,
  deliverBy: null,
  inspectionHours: 48,
  conditions: [],
  payeeEmail: "",
};

/** "95" or "95.5" → "95.00"; anything else is left for the server to reject. */
function money(v: string): string {
  const n = Number(v);
  return v.trim() && Number.isFinite(n) ? n.toFixed(2) : v;
}

const NAIROBI_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" });
/** ISO date-time → the YYYY-MM-DD a date input shows (Nairobi). */
const toDay = (iso: string | null) => (iso ? NAIROBI_DAY.format(new Date(iso)) : "");
/** A picked day means 18:00 Nairobi time that day, the default the AI also uses. */
const fromDay = (day: string) => (day ? `${day}T18:00:00+03:00` : null);

type Props = {
  initial: TermsInput;
  kesPerUsd: number;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (terms: TermsInput) => void;
  /** Hide the payee field (the buyer may edit terms but the seller owns the payout email). */
  showPayee?: boolean;
  /** From a chat the AI read: per-field markers and the messages they cite. */
  hints?: Partial<Record<HintedField, FieldHint>>;
  conditionSources?: string[][];
  chat?: ChatMessage[];
};

export default function TermsForm({
  initial,
  kesPerUsd,
  submitLabel,
  busy,
  onSubmit,
  showPayee = true,
  hints = {},
  conditionSources = [],
  chat = [],
}: Props) {
  const marker = (f: HintedField) => {
    const h = hints[f];
    return h ? (
      <SourceChips ids={h.sources} chat={chat} confidence={h.confidence} note={h.note} />
    ) : null;
  };
  const [t, setT] = useState(initial);
  const [conditions, setConditions] = useState(initial.conditions.join("\n"));
  const set = <K extends keyof TermsInput>(k: K, v: TermsInput[K]) =>
    setT((p) => ({ ...p, [k]: v }));
  const usd = Number(t.price.amount);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          ...t,
          price: { amount: money(t.price.amount), currency: "USD" },
          carrier: t.carrier?.trim() || null,
          conditions: conditions
            .split("\n")
            .map((c) => c.trim())
            .filter(Boolean),
        });
      }}
    >
      <Field label="Item">
        <input
          className={inputClass}
          required
          maxLength={127}
          value={t.item}
          onChange={(e) => set("item", e.target.value)}
          placeholder="Samsung Galaxy A15, used"
        />
        {marker("item")}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Price (USD)"
          hint={
            usd > 0
              ? `≈ KES ${Math.round(usd * kesPerUsd).toLocaleString("en-KE")}`
              : "PayPal does not support KES"
          }
        >
          <input
            className={inputClass}
            required
            inputMode="decimal"
            value={t.price.amount}
            onChange={(e) => set("price", { amount: e.target.value, currency: "USD" })}
            placeholder="95.00"
          />
          {marker("price")}
        </Field>
        <Field label="Quantity">
          <input
            className={inputClass}
            type="number"
            min={1}
            max={1000}
            value={t.quantity}
            onChange={(e) => set("quantity", Number(e.target.value))}
          />
          {marker("quantity")}
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Delivery">
          <select
            className={inputClass}
            value={t.deliveryMethod}
            onChange={(e) => set("deliveryMethod", e.target.value as TermsInput["deliveryMethod"])}
          >
            <option value="courier">Courier</option>
            <option value="rider">Rider</option>
            <option value="pickup">Pickup</option>
            <option value="post">Post</option>
            <option value="other">Other</option>
          </select>
          {marker("deliveryMethod")}
        </Field>
        <Field label="Carrier">
          <input
            className={inputClass}
            maxLength={80}
            value={t.carrier ?? ""}
            onChange={(e) => set("carrier", e.target.value)}
            placeholder="G4S"
          />
          {marker("carrier")}
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ship by (optional)" hint="Blank: 48 h after payment">
          <input
            className={inputClass}
            type="date"
            value={toDay(t.shipBy)}
            onChange={(e) => set("shipBy", fromDay(e.target.value))}
          />
          {marker("shipBy")}
        </Field>
        <Field label="Deliver by (optional)" hint="Blank: 7 days after payment">
          <input
            className={inputClass}
            type="date"
            value={toDay(t.deliverBy)}
            onChange={(e) => set("deliverBy", fromDay(e.target.value))}
          />
          {marker("deliverBy")}
        </Field>
      </div>
      <Field label="Conditions" hint="One per line, e.g. “Screen has no cracks”">
        <textarea
          className={`${inputClass} min-h-20`}
          value={conditions}
          onChange={(e) => setConditions(e.target.value)}
        />
        {conditionSources.some((c) => c.length) && (
          <SourceChips ids={[...new Set(conditionSources.flat())]} chat={chat} />
        )}
      </Field>
      <Field
        label="Inspection window (hours)"
        hint="Time the buyer has after delivery to report a problem"
      >
        <input
          className={inputClass}
          type="number"
          min={1}
          max={168}
          value={t.inspectionHours}
          onChange={(e) => set("inspectionHours", Number(e.target.value))}
        />
      </Field>
      {showPayee && (
        <Field
          label="Seller's PayPal email"
          hint="Where PayPal pays the seller. Sandbox accounts only."
        >
          <input
            className={inputClass}
            required
            type="email"
            value={t.payeeEmail}
            onChange={(e) => set("payeeEmail", e.target.value)}
            placeholder="seller@example.com"
          />
        </Field>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
