"use client";

import { useState } from "react";
import type { AdminDealView } from "@/lib/admin/queries";
import { Button, Card, Field, inputClass, Notice } from "../../../components/ui";

const LABEL_TONE = {
  consistent: "bg-emerald-100 text-emerald-900",
  inconsistent: "bg-red-100 text-red-900",
  uncertain: "bg-amber-100 text-amber-900",
} as Record<string, string>;

async function post(path: string, body: unknown = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok && res.status !== 202) throw new Error(String(data.error ?? "Request failed"));
  return data;
}

export function Decision({ deal }: { deal: AdminDealView }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!deal.canDecide) return null;
  async function decide(decision: "capture" | "void") {
    const what = decision === "capture" ? "pay the seller" : "release the money to the buyer";
    if (!window.confirm(`Really ${what}? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post(`/api/admin/deals/${deal.ref}/decision`, { decision, reason });
      if (res.outcome === "failed") setError(`PayPal refused: ${String(res.issue)}`);
      else if (res.outcome === "pending") setError("PayPal did not answer; the sweep will retry.");
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Decision">
      <div className="flex flex-col gap-3">
        {deal.honourPeriodPassed && (
          <Notice tone="info">
            PayPal&apos;s 3-day honour period has passed. A capture usually works but can fail if
            the buyer&apos;s funding source fails; the deal would then go to CAPTURE_FAILED.
          </Notice>
        )}
        <Field
          label="Reason (required, shown in the audit log)"
          hint="What the evidence shows and why you decided this way."
        >
          <textarea
            className={`${inputClass} min-h-24`}
            minLength={10}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Button disabled={busy || reason.trim().length < 10} onClick={() => decide("capture")}>
            Pay the seller
          </Button>
          <Button
            variant="danger"
            disabled={busy || reason.trim().length < 10}
            onClick={() => decide("void")}
          >
            Release to buyer
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function AiCheck({ deal }: { deal: AdminDealView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = deal.checks[0];
  return (
    <Card title="AI evidence check (advice only)">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-neutral-500">
          The AI compares the terms with the evidence. It cannot pay or refund anyone; you decide.
        </p>
        {latest && (
          <div className="flex flex-col gap-2">
            <span
              className={`self-start rounded px-2 py-0.5 font-medium ${LABEL_TONE[latest.label] ?? ""}`}
            >
              {latest.label}
            </span>
            <ul className="list-disc pl-5">
              {latest.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {latest.flags.length > 0 && (
              <Notice tone="info">
                Evidence that tried to instruct the AI (ignored):{" "}
                {latest.flags.map((f) => `${f.evidence_id}: ${f.reason}`).join("; ")}
              </Notice>
            )}
            <span className="text-xs text-neutral-500">
              {latest.promptVersion} · {new Date(latest.createdAt).toLocaleString("en-GB")}
            </span>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await post(`/api/admin/deals/${deal.ref}/check`);
              window.location.reload();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Asking the AI…" : latest ? "Check again" : "Ask the AI to check the evidence"}
        </Button>
      </div>
    </Card>
  );
}

export function Unlock({ deal }: { deal: AdminDealView }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!deal.handover.locked) return null;
  return (
    <Card title="Handover code locked">
      <div className="flex flex-col gap-3 text-sm">
        <p>
          The seller entered 5 wrong codes. Talk to both parties before unlocking: a seller guessing
          codes without the item handed over is a warning sign.
        </p>
        <Field label="Reason for unlocking">
          <textarea
            className={`${inputClass} min-h-20`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button
          variant="secondary"
          disabled={reason.trim().length < 10}
          onClick={async () => {
            try {
              await post(`/api/admin/deals/${deal.ref}/unlock`, { reason });
              window.location.reload();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Unlock code entry
        </Button>
      </div>
    </Card>
  );
}
