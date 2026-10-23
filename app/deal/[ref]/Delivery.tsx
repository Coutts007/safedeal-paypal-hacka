"use client";

import { useState } from "react";
import type { DealView } from "@/lib/deals/service";
import { Button, Card, Field, inputClass, nairobi, Notice } from "../../components/ui";

// Handover code (deliveries without courier tracking) and Extend delivery date (section 7.1).

/** The buyer's 6-digit code, shown on every visit until delivery is proven. */
export function HandoverCode({ code }: { code: string }) {
  return (
    <Card title="Your handover code">
      <p
        className="text-center font-mono text-4xl font-bold tracking-[0.3em] text-neutral-900 dark:text-neutral-100"
        aria-label={`Handover code ${code.split("").join(" ")}`}
      >
        {code}
      </p>
      <p className="mt-3 text-sm font-medium">
        Give this code only when you have the item in your hands.
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        When the seller enters it, the delivery counts as proven: you then have the inspection
        window to report a problem before the seller is paid. Never send it in the chat.
      </p>
    </Card>
  );
}

export function HandoverForm({
  busy,
  attemptsLeft,
  onSubmit,
}: {
  busy: boolean;
  attemptsLeft: number;
  onSubmit: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Enter the buyer&apos;s handover code
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code);
      }}
    >
      <Field
        label="Buyer's 6-digit code"
        hint={`Ask for it when you hand over the item. ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left before entry locks.`}
      >
        <input
          className={`${inputClass} font-mono text-xl tracking-widest`}
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          pattern="[0-9 \-]{6,8}"
          maxLength={8}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Button type="submit" disabled={busy}>
        {busy ? "Checking…" : "Confirm handover"}
      </Button>
    </form>
  );
}

const NAIROBI_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** ISO time → "YYYY-MM-DDTHH:MM" in Nairobi, the format of a datetime-local input. */
function nairobiLocal(iso: string): string {
  const p = Object.fromEntries(
    NAIROBI_PARTS.formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Propose a new deliver-by date, or answer the other party's proposal. */
export function Extension({
  view,
  now,
  busy,
  onPropose,
  onDecide,
}: {
  view: DealView;
  now: number;
  busy: boolean;
  onPropose: (iso: string) => void;
  onDecide: (accept: boolean) => void;
}) {
  const ext = view.extension;
  const other = view.role === "buyer" ? "the seller" : "the buyer";
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState("");
  const canPropose = view.actions.includes("propose_extension");
  const canDecide = view.actions.includes("decide_extension");
  if (!ext && !canPropose) return null;

  return (
    <Card title="Delivery date">
      <div className="flex flex-col gap-3 text-sm">
        {view.deadlines.deliverBy && (
          <p>
            Agreed delivery by <strong>{nairobi(view.deadlines.deliverBy)}</strong>.
          </p>
        )}
        {ext && canDecide && (
          <>
            <Notice tone="info">
              {ext.proposedBy === "seller" ? "The seller" : "The buyer"} proposes a new delivery
              date: <strong>{nairobi(ext.newDeliverBy)}</strong>. The money stays held either way.
            </Notice>
            <div className="grid grid-cols-2 gap-3">
              <Button disabled={busy} onClick={() => onDecide(true)}>
                Accept
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => onDecide(false)}>
                Reject
              </Button>
            </div>
          </>
        )}
        {ext && !canDecide && (
          <p className="text-neutral-600 dark:text-neutral-400">
            You proposed {nairobi(ext.newDeliverBy)}. Waiting for {other} to accept.
          </p>
        )}
        {canPropose && !open && (
          <Button variant="secondary" disabled={busy} onClick={() => setOpen(true)}>
            {ext ? "Propose a different date" : "Courier late? Propose a new delivery date"}
          </Button>
        )}
        {canPropose && open && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              onPropose(`${at}:00+03:00`);
              setOpen(false);
            }}
          >
            <Field
              label="New delivery date and time (Nairobi)"
              hint={
                view.extensionLimit
                  ? `Must be before ${nairobi(view.extensionLimit)}, while PayPal still holds the money. ${other[0].toUpperCase()}${other.slice(1)} has to accept it.`
                  : undefined
              }
            >
              <input
                type="datetime-local"
                className={inputClass}
                required
                min={nairobiLocal(new Date(now + 60_000).toISOString())}
                max={view.extensionLimit ? nairobiLocal(view.extensionLimit) : undefined}
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy || !at}>
              Send to {other}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}
