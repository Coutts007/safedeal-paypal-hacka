"use client";

import { useState } from "react";
import TermsForm, { EMPTY_TERMS, type TermsInput } from "./components/TermsForm";
import { Button, Card, Field, inputClass, Notice } from "./components/ui";

type Created = { ref: string; links: { seller: string; buyer: string } };

export default function CreateDeal({ kesPerUsd }: { kesPerUsd: number }) {
  const [sellerName, setSellerName] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(terms: TermsInput) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerName, buyerName, terms }),
      });
      const data = (await res.json()) as Created & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not create the deal");
      setCreated(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Card title="Deal created">
        <div className="flex flex-col gap-3">
          <p>
            Send this link to {buyerName || "the buyer"}. It is their private page for this deal.
          </p>
          <code className="rounded-lg bg-neutral-100 p-2 text-xs break-all text-neutral-900">
            {created.links.buyer}
          </code>
          <Button
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(created.links.buyer);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy the buyer's link"}
          </Button>
          <Notice tone="info">
            Keep your own link private: anyone with it can act as the seller.
          </Notice>
          <a
            className="min-h-11 rounded-xl bg-emerald-600 px-4 py-2 text-center font-medium text-white hover:bg-emerald-700"
            href={created.links.seller}
          >
            Open my deal page
          </a>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Start a deal (seller)">
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Field label="Your name">
          <input
            className={inputClass}
            required
            maxLength={60}
            value={sellerName}
            onChange={(e) => setSellerName(e.target.value)}
            placeholder="David"
          />
        </Field>
        <Field label="Buyer's name">
          <input
            className={inputClass}
            required
            maxLength={60}
            value={buyerName}
            onChange={(e) => setBuyerName(e.target.value)}
            placeholder="Shemaya"
          />
        </Field>
      </div>
      {error && (
        <div className="mb-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <TermsForm
        initial={EMPTY_TERMS}
        kesPerUsd={kesPerUsd}
        submitLabel="Create deal"
        busy={busy}
        onSubmit={submit}
      />
    </Card>
  );
}
