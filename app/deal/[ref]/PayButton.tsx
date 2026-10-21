"use client";

import { useEffect, useRef, useState } from "react";
import type {
  PayPalOneTimePaymentSession,
  PayPalSdkError,
  PayPalSdkInstance,
} from "@/types/paypal-sdk";
import { Notice } from "../../components/ui";

// PayPal JS SDK v6 (BUILD_PLAN 8.2). The order is created on the server from the locked terms;
// the browser only passes the approved order id back, and the server re-checks it with PayPal.

type Props = {
  clientId: string;
  sdkUrl: string;
  /** POST to a deal route with the party's token; resolves to the parsed JSON or throws. */
  call: (path: string, body?: unknown) => Promise<Record<string, unknown>>;
  onHeld: () => void;
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.paypal) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("PayPal could not be loaded. Check your connection."));
    document.head.appendChild(el);
  });
}

const MESSAGES: Record<string, string> = {
  INSTRUMENT_DECLINED:
    "PayPal declined that funding source. Please try again with another card or account.",
  ERR_INVALID_CLIENT_TOKEN: "The PayPal session expired. Reload the page and try again.",
  NETWORK_ERROR: "Network problem while talking to PayPal. Check your connection and try again.",
};

export default function PayButton({ clientId, sdkUrl, call, onHeld }: Props) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<PayPalOneTimePaymentSession | null>(null);
  const started = useRef(false);
  const callRef = useRef(call);
  const heldRef = useRef(onHeld);
  callRef.current = call;
  heldRef.current = onHeld;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    async function init() {
      if (!clientId) throw new Error("PayPal is not configured (NEXT_PUBLIC_PAYPAL_CLIENT_ID).");
      await loadScript(sdkUrl);
      const paypal = window.paypal;
      if (!paypal) throw new Error("PayPal could not be loaded.");
      const sdk: PayPalSdkInstance = await paypal.createInstance({
        clientId,
        components: ["paypal-payments"],
        pageType: "checkout",
        clientMetadataId: crypto.randomUUID(),
      });
      const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
      if (!methods.isEligible("paypal"))
        throw new Error("PayPal is not available in this browser.");

      session.current = sdk.createPayPalOneTimePaymentSession({
        async onApprove({ orderId }) {
          setBusy(true);
          setError(null);
          try {
            const res = await callRef.current("authorize", { orderId });
            if (res.outcome === "moved") heldRef.current();
            else if (res.outcome === "failed")
              setError(
                MESSAGES[String(res.issue)] ??
                  `PayPal could not hold the money (${String(res.issue)}).`,
              );
            else if (res.outcome === "pending")
              setError("PayPal is slow to answer. Wait a moment, then reload this page.");
            else setError(String(res.reason ?? res.error ?? "Payment could not be completed."));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
            heldRef.current();
          }
        },
        onCancel() {
          setError("Payment cancelled. You can try again whenever you are ready.");
        },
        onError(err: PayPalSdkError) {
          setError(MESSAGES[err.code ?? ""] ?? `PayPal error: ${err.message}`);
        },
      });
      if (session.current.hasReturned?.()) await session.current.resume?.();
      setReady(true);
    }
    init().catch((e: unknown) => setError((e as Error).message));
  }, [clientId, sdkUrl]);

  async function order(): Promise<{ orderId: string }> {
    const res = await callRef.current("order");
    return { orderId: String(res.id) };
  }

  async function pay() {
    const s = session.current;
    if (!s) return;
    setError(null);
    try {
      await s.start({ presentationMode: "auto" }, order());
    } catch (e) {
      const err = e as PayPalSdkError;
      if (err.code === "ERR_DEV_UNABLE_TO_OPEN_POPUP") {
        await s.start({ presentationMode: "redirect" }, order());
        return;
      }
      setError(MESSAGES[err.code ?? ""] ?? err.message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <paypal-button type="pay" hidden={!ready || busy} onClick={pay} />
      {!ready && !error && <p className="text-sm text-neutral-500">Loading PayPal…</p>}
      {busy && <Notice tone="info">Holding the money with PayPal…</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
