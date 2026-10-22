"use client";

import { useState } from "react";
import type { ReadChatResponse } from "@/lib/ai/service";
import { ChatFlags } from "./components/Sources";
import TermsForm, { EMPTY_TERMS, type TermsInput } from "./components/TermsForm";
import { Button, Card, Field, inputClass, Notice } from "./components/ui";

type Created = { ref: string; links: { seller: string; buyer: string } };

const NOT_READ: Record<Exclude<ReadChatResponse["status"], "ok">, string> = {
  empty_chat: "That chat has no messages. Paste the conversation, or fill in the form by hand.",
  ai_unavailable:
    "The AI is not answering right now. Fill in the form by hand, or try again later.",
  invalid_output: "The AI could not read this chat reliably. Fill in the form by hand.",
  refused: "The AI could not read this chat. Fill in the form by hand.",
};

export default function CreateDeal({ kesPerUsd }: { kesPerUsd: number }) {
  const [sellerName, setSellerName] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [chatText, setChatText] = useState("");
  const [reading, setReading] = useState<ReadChatResponse | null>(null);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState<"read" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  async function readChat() {
    setBusy("read");
    setError(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: chatText }),
      });
      const data = (await res.json()) as ReadChatResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not read the chat");
      setReading(data);
      if (data.status !== "ok") setError(NOT_READ[data.status]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function submit(terms: TermsInput) {
    setBusy("create");
    setError(null);
    try {
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerName,
          buyerName,
          terms,
          extractionId: reading?.extractionId ?? null,
        }),
      });
      const data = (await res.json()) as Created & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not create the deal");
      setCreated(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
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

  const proposal = reading?.proposal ?? null;
  const showForm = manual || reading !== null;

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

      {!showForm && (
        <div className="flex flex-col gap-3">
          <Field
            label="Paste your chat with the buyer"
            hint="WhatsApp: open the chat → ⋮ → More → Export chat → Without media, then paste the text. Phone numbers, emails and M-PESA codes are removed before the AI reads it."
          >
            <textarea
              className={`${inputClass} min-h-48 font-mono text-sm`}
              value={chatText}
              maxLength={15000}
              onChange={(e) => setChatText(e.target.value)}
              placeholder={
                "[20/10/2026, 09:01] Shemaya: Is the A15 still available?\n[20/10/2026, 09:03] David: Yes, 12k. I can send by G4S kesho"
              }
            />
          </Field>
          <Button onClick={readChat} disabled={busy !== null || !chatText.trim()}>
            {busy === "read" ? "Reading the chat…" : "Read the chat"}
          </Button>
          <button
            type="button"
            className="text-sm text-emerald-700 underline"
            onClick={() => setManual(true)}
          >
            Fill in the form by hand instead
          </button>
          <p className="text-xs text-neutral-500">
            The AI only fills in the form. You and the buyer check and confirm every field before
            any money moves.
          </p>
        </div>
      )}

      {error && (
        <div className="my-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {showForm && (
        <div className="flex flex-col gap-3">
          {proposal && (
            <>
              <ChatFlags flags={proposal.flags} chat={reading?.messages ?? []} />
              <Notice tone="info">
                The AI filled in what it found in the chat. Check each field: tap “From chat” to see
                the message it came from.
                {proposal.missing.length > 0 &&
                  ` Not found in the chat: ${proposal.missing.join(", ").replaceAll("_", " ")}.`}
                {proposal.notes && ` ${proposal.notes}`}
              </Notice>
            </>
          )}
          <TermsForm
            key={reading?.extractionId ?? "manual"}
            initial={proposal?.terms ?? EMPTY_TERMS}
            kesPerUsd={kesPerUsd}
            submitLabel="Create deal"
            busy={busy === "create"}
            onSubmit={submit}
            hints={proposal?.hints}
            conditionSources={proposal?.conditionSources}
            chat={reading?.messages}
          />
          <button
            type="button"
            className="text-sm text-neutral-600 underline"
            onClick={() => {
              setReading(null);
              setManual(false);
              setError(null);
            }}
          >
            Start again with a chat
          </button>
        </div>
      )}
    </Card>
  );
}
