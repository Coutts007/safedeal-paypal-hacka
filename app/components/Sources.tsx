"use client";

import { useState } from "react";
import type { ChatMessage } from "@/lib/ai/chat";
import type { Confidence, FieldAction } from "@/lib/ai/proposal";

// "From the chat" markers on the seller's form: what the person needs to do about a field, or how
// clearly the chat said it, and the messages it came from. Tapping a message id shows that
// message, so people can check the AI against what was actually said. Never red: nothing here is
// an error, only something to look at.

const GREEN = "bg-emerald-100 text-emerald-800";
const AMBER = "bg-amber-100 text-amber-900";
const GREY = "bg-neutral-100 text-neutral-700";

const ACTION: Record<FieldAction, { label: string; tone: string }> = {
  set_usd: { label: "Confirm the US$ price", tone: AMBER },
  fill_in: { label: "Not in the chat", tone: GREY },
};

const CONFIDENCE: Record<Confidence, { label: string; tone: string }> = {
  high: { label: "Matches the chat", tone: GREEN },
  medium: { label: "Check this", tone: AMBER },
  low: { label: "Not clear in the chat", tone: AMBER },
};

function chip(confidence?: Confidence, action?: FieldAction) {
  if (action) return ACTION[action];
  return confidence ? CONFIDENCE[confidence] : null;
}

export function SourceChips({
  ids,
  chat,
  confidence,
  action,
  edited,
  note,
}: {
  ids: string[];
  chat: ChatMessage[];
  confidence?: Confidence;
  action?: FieldAction;
  edited?: boolean;
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const quoted = chat.filter((m) => ids.includes(m.id));
  const marker = chip(confidence, action);
  if (!marker && !quoted.length && !edited && !note) return null;
  return (
    <span className="mt-1 flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1 text-xs">
        {edited ? (
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-700">
            Changed by hand
          </span>
        ) : (
          marker && <span className={`rounded px-1.5 py-0.5 ${marker.tone}`}>{marker.label}</span>
        )}
        {quoted.length > 0 && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-emerald-700 underline"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? "Hide chat" : `See message ${quoted.map((m) => m.id).join(", ")}`}
          </button>
        )}
      </span>
      {note && <span className="text-xs text-neutral-600">{note}</span>}
      {open && (
        <span className="flex flex-col gap-1 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-800">
          {quoted.map((m) => (
            <span key={m.id}>
              <span className="font-mono text-neutral-500">[{m.id}]</span>{" "}
              {m.from && <span className="font-medium">{m.from}: </span>}
              <span className="whitespace-pre-wrap">{m.text}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** Messages that tried to instruct the AI. They were ignored; people should know they exist. */
export function ChatFlags({
  flags,
  chat,
}: {
  flags: { messageId: string; reason: string }[];
  chat: ChatMessage[];
}) {
  if (!flags.length) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="font-medium">
        Part of this chat tried to give instructions to the AI. It was ignored and treated as
        ordinary chat text. Check every field yourself.
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-xs">
        {flags.map((f) => {
          const m = chat.find((c) => c.id === f.messageId);
          return (
            <li key={f.messageId}>
              <span className="font-mono">[{f.messageId}]</span>{" "}
              {m ? `“${m.text.slice(0, 160)}”` : ""}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
