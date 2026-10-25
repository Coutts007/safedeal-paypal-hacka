"use client";

import { useState } from "react";

/**
 * "Log in with PayPal" (Phase 6b). Asks SafeDeal for PayPal's sign-in address, then goes to
 * PayPal's own page; SafeDeal never sees the PayPal password.
 */
export function PaypalLoginButton() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function start() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/auth/paypal/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const { url } = (await res.json()) as { url?: string };
      if (!res.ok || !url) throw new Error("no url");
      window.location.assign(url);
    } catch {
      setBusy(false);
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#0070ba] px-4 py-2 font-medium text-white transition select-none hover:bg-[#005ea6] focus-visible:ring-2 focus-visible:ring-[#0070ba] focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.98] active:bg-[#003087] disabled:opacity-80"
      >
        {busy ? "Opening PayPal…" : "Log in with PayPal"}
      </button>
      {failed && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          Could not reach SafeDeal just now. Please try again.
        </p>
      )}
    </div>
  );
}
