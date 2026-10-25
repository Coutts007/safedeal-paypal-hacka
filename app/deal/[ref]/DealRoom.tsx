"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { DealView } from "@/lib/deals/service";
import type { HintedField } from "@/lib/ai/proposal";
import { CopyButton } from "../../components/CopyButton";
import { ChatFlags, SourceChips } from "../../components/Sources";
import TermsForm, { type TermsInput } from "../../components/TermsForm";
import { Button, Card, Field, inputClass, kes, nairobi, Notice } from "../../components/ui";
import { Extension, HandoverCode, HandoverForm } from "./Delivery";
import { EvidenceForm, EvidenceList } from "./Evidence";
import PayButton from "./PayButton";

type Props = {
  initial: DealView;
  token: string;
  kesPerUsd: number;
  paypal: { clientId: string; sdkUrl: string };
};

const POLL_MS = 5_000;

const STEP_STYLES = {
  done: "bg-emerald-600 text-white",
  current: "bg-emerald-100 text-emerald-900 ring-2 ring-emerald-600",
  todo: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800",
  stopped: "bg-amber-100 text-amber-900 ring-2 ring-amber-500",
};

/** "in 1 h 20 min" / "2 min ago", from the server's clock so a wrong phone clock does not matter. */
function relative(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60_000);
  const text =
    m < 1
      ? "under a minute"
      : m < 60
        ? `${m} min`
        : m < 48 * 60
          ? `${Math.floor(m / 60)} h ${m % 60} min`
          : `${Math.round(m / 1440)} days`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

export default function DealRoom({ initial, token, kesPerUsd, paypal }: Props) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [skew, setSkew] = useState(() => new Date(initial.serverTime).getTime() - Date.now());
  const [now, setNow] = useState(() => Date.now() + skew);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/deals/${view.ref}`, {
      headers: { "x-deal-token": token },
      cache: "no-store",
    });
    if (!res.ok) return;
    const next = (await res.json()) as DealView;
    setSkew(new Date(next.serverTime).getTime() - Date.now());
    setView(next);
  }, [view.ref, token]);

  useEffect(() => {
    const poll = setInterval(() => void refresh(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now() + skew), 15_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh, skew]);

  const call = useCallback(
    async (path: string, body: unknown = {}) => {
      const res = await fetch(`/api/deals/${view.ref}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-deal-token": token },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok && res.status !== 202)
        throw new Error(String(data.error ?? "Something went wrong"));
      return data;
    },
    [view.ref, token],
  );

  async function act(name: string, path: string, body?: unknown, done?: string) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const res = await call(path, body);
      if (res.outcome === "pending")
        setNotice("PayPal is slow to answer. SafeDeal will keep trying.");
      else if (res.outcome === "failed")
        setError(`PayPal refused: ${String(res.issue)}. A reviewer has been alerted.`);
      else if (done) setNotice(done);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const { role, terms, names } = view;
  const me = role === "buyer" ? names.buyer : names.seller;
  const other = role === "buyer" ? names.seller : names.buyer;
  const has = (a: DealView["actions"][number]) => view.actions.includes(a);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-sm font-semibold text-emerald-700">
          SafeDeal
        </Link>
        <h1 className="text-2xl font-bold">{terms?.item ?? "Deal"}</h1>
        {view.amount && (
          <p className="text-lg">
            <span className="font-semibold">US${view.amount}</span>
            {view.kesEstimate !== null && (
              <span className="text-neutral-500"> · ≈ {kes(view.kesEstimate)} (estimate)</span>
            )}
          </p>
        )}
        <p className="text-sm text-neutral-500">
          You are the {role}
          {me ? ` (${me})` : ""}
          {other ? `, dealing with ${other}` : ""}. Ref {view.ref}.
        </p>
      </header>

      <ol
        className="grid grid-cols-5 gap-1 text-center text-[11px] leading-tight sm:text-xs"
        aria-label="Progress"
      >
        {view.timeline.map((s) => (
          <li
            key={s.key}
            className={`rounded-lg px-1 py-2 ${STEP_STYLES[s.state]}`}
            aria-current={s.state === "current" ? "step" : undefined}
          >
            {s.label}
          </li>
        ))}
      </ol>

      <Notice
        tone={
          [
            "VOIDED",
            "EXPIRED",
            "CANCELLED",
            "IN_REVIEW",
            "CAPTURE_FAILED",
            "FUNDING_FAILED",
            "DISPUTED",
          ].includes(view.state)
            ? "info"
            : "ok"
        }
      >
        {view.statusLine}
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="info">{notice}</Notice>}
      {view.notes.map((n) => (
        <Notice key={n} tone="info">
          {n}
        </Notice>
      ))}

      {view.handover.code && <HandoverCode code={view.handover.code} />}

      {view.actions.length > 0 && (
        <Card title="What you can do">
          <div className="flex flex-col gap-3">
            {has("confirm_terms") && (
              <Button
                disabled={!!busy}
                onClick={() =>
                  act("confirm", "confirm", { termsHash: view.termsHash }, "Terms confirmed.")
                }
              >
                {busy === "confirm" ? "Confirming…" : "Confirm these terms"}
              </Button>
            )}
            {view.state === "DRAFT" && !has("confirm_terms") && (
              <p className="text-sm text-neutral-500">
                You confirmed these terms. Waiting for {other ?? "the other party"}.
              </p>
            )}
            {has("pay") && (
              <PayButton
                clientId={paypal.clientId}
                sdkUrl={paypal.sdkUrl}
                call={(p, b) => call(p, b ?? {})}
                onHeld={() => void refresh()}
              />
            )}
            {has("enter_handover") && (
              <HandoverForm
                busy={busy === "handover"}
                attemptsLeft={view.handover.attemptsLeft}
                onSubmit={(code) =>
                  act(
                    "handover",
                    "handover",
                    { code },
                    "Handover confirmed. The buyer now has the inspection window.",
                  )
                }
              />
            )}
            {has("simulate_delivery") && (
              <Button
                variant="secondary"
                disabled={!!busy}
                onClick={() =>
                  act(
                    "simulate",
                    "simulate-delivery",
                    {},
                    "Test courier: delivered event sent and verified.",
                  )
                }
              >
                {busy === "simulate" ? "Sending…" : "Demo: simulate courier delivery"}
              </Button>
            )}
            {has("add_tracking") && (
              <TrackingForm
                busy={busy === "tracking"}
                onSubmit={(b) => act("tracking", "evidence", b, "Tracking added.")}
              />
            )}
            {has("confirm_receipt") && (
              <Button
                disabled={!!busy}
                onClick={() => act("receipt", "receipt", { action: "confirm" })}
              >
                {busy === "receipt" ? "Paying the seller…" : "I received it: pay the seller"}
              </Button>
            )}
            {has("report_problem") && (
              <ProblemForm
                busy={busy === "problem"}
                onSubmit={(note) =>
                  act(
                    "problem",
                    "receipt",
                    { action: "problem", note },
                    "Problem reported. A reviewer will look at it.",
                  )
                }
              />
            )}
            {has("add_evidence") && <EvidenceForm view={view} token={token} onAdded={refresh} />}
            {has("download_bundle") && (
              <BundleButton reference={view.ref} token={token} onError={setError} />
            )}
            {has("edit_terms") && !editing && (
              <Button variant="secondary" disabled={!!busy} onClick={() => setEditing(true)}>
                Change the terms
              </Button>
            )}
            {has("cancel") && (
              <Button
                variant="danger"
                disabled={!!busy}
                onClick={() => {
                  if (window.confirm("Cancel this deal? No money has moved."))
                    void act("cancel", "cancel");
                }}
              >
                Cancel the deal
              </Button>
            )}
          </div>
        </Card>
      )}

      {editing && terms && (
        <Card title="Propose new terms">
          <p className="mb-3 text-sm text-neutral-500">Both of you will need to confirm again.</p>
          <TermsForm
            initial={terms as TermsInput}
            kesPerUsd={kesPerUsd}
            submitLabel="Save new terms"
            busy={busy === "terms"}
            showPayee={role === "seller"}
            onSubmit={async (t) => {
              await act("terms", "terms", { terms: t }, "New terms saved.");
              setEditing(false);
            }}
          />
          <div className="mt-2">
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Keep the current terms
            </Button>
          </div>
        </Card>
      )}

      {view.buyerLink && view.state === "DRAFT" && (
        <Card title={`Send to ${names.buyer ?? "the buyer"}`}>
          <code className="block rounded-lg bg-neutral-100 p-2 text-xs break-all text-neutral-900">
            {view.buyerLink}
          </code>
          <div className="mt-2">
            <CopyButton text={view.buyerLink} label="Copy the buyer's link" />
          </div>
        </Card>
      )}

      <Deadlines view={view} now={now} />

      <Extension
        view={view}
        now={now}
        busy={busy === "extend"}
        onPropose={(iso) =>
          act(
            "extend",
            "extend",
            { action: "propose", newDeliverBy: iso },
            "New date sent. It applies once the other party accepts.",
          )
        }
        onDecide={(accept) =>
          act(
            "extend",
            "extend",
            { action: accept ? "accept" : "reject", extensionId: view.extension?.id },
            accept ? "New delivery date agreed." : "Kept the agreed delivery date.",
          )
        }
      />

      {terms && <ChatFlags flags={view.chatFlags} chat={view.chat} />}

      {terms && (
        <Card title={`Terms (version ${view.termsVersion})`}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-neutral-500">Item</dt>
            <dd>
              {terms.quantity} × {terms.item}
              {from(view, "item")}
            </dd>
            <dt className="text-neutral-500">Price</dt>
            <dd>
              US${terms.price.amount}
              {from(view, "price")}
            </dd>
            <dt className="text-neutral-500">Delivery</dt>
            <dd>
              <span className="capitalize">{terms.deliveryMethod}</span>
              {terms.carrier ? ` (${terms.carrier})` : ""}
              {from(view, "deliveryMethod")}
            </dd>
            {terms.shipBy && (
              <>
                <dt className="text-neutral-500">Ship by</dt>
                <dd>
                  {nairobi(terms.shipBy)}
                  {from(view, "shipBy")}
                </dd>
              </>
            )}
            {terms.deliverBy && (
              <>
                <dt className="text-neutral-500">Deliver by</dt>
                <dd>
                  {nairobi(terms.deliverBy)}
                  {from(view, "deliverBy")}
                </dd>
              </>
            )}
            <dt className="text-neutral-500">Inspection</dt>
            <dd>{terms.inspectionHours} h after delivery</dd>
            <dt className="text-neutral-500">Paid to</dt>
            <dd className="break-all">{terms.payeeEmail}</dd>
            {terms.conditions.length > 0 && (
              <>
                <dt className="text-neutral-500">Conditions</dt>
                <dd>
                  <ul className="list-disc pl-4">
                    {terms.conditions.map((c) => (
                      <li key={c}>
                        {c}
                        <SourceChips
                          ids={view.sources.conditions?.find((x) => x.text === c)?.sources ?? []}
                          chat={view.chat}
                        />
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            <dt className="text-neutral-500">Confirmed</dt>
            <dd>
              {names.seller ?? "Seller"} {view.confirmed.seller ? "✓" : "—"} ·{" "}
              {names.buyer ?? "Buyer"} {view.confirmed.buyer ? "✓" : "—"}
            </dd>
          </dl>
        </Card>
      )}

      <EvidenceList view={view} token={token} />

      <Card title="History">
        <ol className="flex flex-col gap-1 text-sm">
          {view.history.map((h, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span>{h.label}</span>
              <span className="shrink-0 text-neutral-500">{nairobi(h.at)}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-neutral-500">
          Every step is recorded in a tamper-evident log.
        </p>
      </Card>
    </main>
  );
}

function Deadlines({ view, now }: { view: DealView; now: number }) {
  const d = view.deadlines;
  const rows: [string, string | null][] =
    view.state === "AUTHORIZED"
      ? [
          ["Seller must add tracking", d.shipBy],
          ["Hold ends", d.holdEndsAt],
        ]
      : view.state === "SHIPPED"
        ? [
            ["Expected delivery by", d.deliverBy],
            ["Hold ends", d.holdEndsAt],
          ]
        : view.state === "DELIVERED"
          ? [
              ["Inspection window ends", d.inspectionEndsAt],
              ["Hold ends", d.holdEndsAt],
            ]
          : [];
  const shown = rows.filter((r): r is [string, string] => r[1] !== null);
  if (!shown.length) return null;
  return (
    <Card title="Deadlines">
      <dl className="flex flex-col gap-2 text-sm">
        {shown.map(([label, iso]) => (
          <div key={label} className="flex flex-wrap justify-between gap-x-3">
            <dt className="text-neutral-500">{label}</dt>
            <dd>
              {nairobi(iso)} <span className="text-neutral-500">({relative(iso, now)})</span>
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function TrackingForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (b: { carrier: string; trackingNumber: string }) => void;
}) {
  const [carrier, setCarrier] = useState("G4S");
  const [trackingNumber, setTrackingNumber] = useState("");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ carrier, trackingNumber });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Carrier">
          <input
            className={inputClass}
            required
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
          />
        </Field>
        <Field label="Tracking number">
          <input
            className={inputClass}
            required
            minLength={3}
            value={trackingNumber}
            onChange={(e) => setTrackingNumber(e.target.value)}
          />
        </Field>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Add tracking"}
      </Button>
    </form>
  );
}

function ProblemForm({ busy, onSubmit }: { busy: boolean; onSubmit: (note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Report a problem
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(note);
      }}
    >
      <Field label="What is wrong?" hint="The money stays held while a reviewer looks at it.">
        <textarea
          className={`${inputClass} min-h-20`}
          required
          minLength={3}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="danger" disabled={busy}>
        {busy ? "Sending…" : "Send to a reviewer"}
      </Button>
    </form>
  );
}

/**
 * "From the chat" marker for a deal-card field, when the deal started from a chat: the message it
 * came from, or that it was changed by hand. The AI's confidence is only for the seller's form;
 * by now a person has checked every field.
 */
function from(view: DealView, field: HintedField) {
  const ref = view.sources.fields?.[field];
  if (!ref || !view.chat.length) return null;
  return <SourceChips ids={ref.sources} chat={view.chat} edited={ref.edited} />;
}

/**
 * Downloads the evidence bundle PDF and shows each step, since building it takes a moment:
 * "Preparing the PDF…", then "Downloaded ✓".
 */
function BundleButton({
  reference,
  token,
  onError,
}: {
  reference: string;
  token: string;
  onError: (message: string | null) => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  async function download() {
    setState("busy");
    onError(null);
    try {
      const res = await fetch(`/api/deals/${reference}/bundle`, {
        headers: { "x-deal-token": token },
      });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `safedeal-${reference}-evidence.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking at once can cancel the download in Safari and Firefox.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setState("done");
      setTimeout(() => setState("idle"), 3000);
    } catch {
      setState("idle");
      onError("Could not download the evidence bundle. Check your connection and try again.");
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant={state === "done" ? "success" : "secondary"}
        disabled={state === "busy"}
        aria-busy={state === "busy"}
        onClick={() => void download()}
      >
        {state === "busy"
          ? "Preparing the PDF…"
          : state === "done"
            ? "Downloaded ✓"
            : "Download the evidence bundle (PDF)"}
      </Button>
      <span
        role="status"
        aria-live="polite"
        className="text-xs text-neutral-600 dark:text-neutral-400"
      >
        {state === "done" && "Saved to your downloads. Upload it in PayPal's Resolution Center."}
      </span>
    </div>
  );
}
