"use client";

import Link from "next/link";
import { useState } from "react";
import { proposalSummary, type Proposal } from "@/lib/ai/proposal";
import type { ReadChatResponse } from "@/lib/ai/service";
import { CopyButton } from "./components/CopyButton";
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

/** A seller logged in with PayPal: deals pay out to their verified PayPal email. */
export type SellerAccount = { name: string | null; email: string };

export default function CreateDeal({
  kesPerUsd,
  account,
}: {
  kesPerUsd: number;
  account?: SellerAccount;
}) {
  const [sellerName, setSellerName] = useState(account?.name ?? "");
  const [buyerName, setBuyerName] = useState("");
  const [chatText, setChatText] = useState("");
  const [reading, setReading] = useState<ReadChatResponse | null>(null);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState<"read" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

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
          <CopyButton text={created.links.buyer} label="Copy the buyer's link" />
          <Notice tone="info">
            Keep your own link private: anyone with it can act as the seller.
          </Notice>
          <a
            className="min-h-11 rounded-xl bg-emerald-600 px-4 py-2 text-center font-medium text-white hover:bg-emerald-700"
            href={created.links.seller}
          >
            Open my deal page
          </a>
          {account && (
            <Link
              className="text-center text-sm text-emerald-700 underline dark:text-emerald-400"
              href="/dashboard"
            >
              Back to my deals
            </Link>
          )}
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
              <ReadingSummary proposal={proposal} />
            </>
          )}
          {account && (
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              Paid to your PayPal account <span className="font-medium">{account.email}</span>.
            </p>
          )}
          <TermsForm
            key={reading?.extractionId ?? "manual"}
            initial={{
              ...(proposal?.terms ?? EMPTY_TERMS),
              ...(account && { payeeEmail: account.email }),
            }}
            showPayee={!account}
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

const list = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");

/** What the AI filled in, and the few things left for the seller. */
function ReadingSummary({ proposal }: { proposal: Proposal }) {
  const { filled, needsYou, check, notMentioned } = proposalSummary(proposal);
  return (
    <Notice tone="info">
      <span className="flex flex-col gap-1">
        <span>
          The AI filled in {filled} {filled === 1 ? "field" : "fields"} from the chat. Tap “See
          message” on a field to see where it came from.
        </span>
        {needsYou.length > 0 && (
          <span>
            <span className="font-medium">Needs you:</span> {list(needsYou)}.
          </span>
        )}
        {check.length > 0 && (
          <span>
            <span className="font-medium">Worth a look:</span> {list(check)}.
          </span>
        )}
        {notMentioned.length > 0 && (
          <span>
            <span className="font-medium">Not in the chat:</span> {list(notMentioned)}. Fill in if
            you agreed one; dates can stay blank.
          </span>
        )}
        {proposal.notes && <span>{proposal.notes}</span>}
      </span>
    </Notice>
  );
}
