"use client";

import { useEffect, useRef, useState } from "react";
import type {
  PayPalOneTimePaymentSession,
  PayPalSdkError,
  PayPalSdkInstance,
} from "@/types/paypal-sdk";

type Props = { clientId: string; sdkUrl: string };

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.paypal) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("PayPal SDK script failed to load"));
    document.head.appendChild(el);
  });
}

async function createOrder(): Promise<{ orderId: string }> {
  const res = await fetch("/api/spike/order", { method: "POST" });
  const data = (await res.json()) as { id?: string; debugId?: string };
  if (!res.ok || !data.id) throw new Error(`Order create failed (debug_id ${data.debugId})`);
  return { orderId: data.id };
}

export default function SpikeCheckout({ clientId, sdkUrl }: Props) {
  const [log, setLog] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const sessionRef = useRef<PayPalOneTimePaymentSession | null>(null);
  const started = useRef(false);

  const note = (line: string) =>
    setLog((l) => [...l, `${new Date().toLocaleTimeString("en-GB")}  ${line}`]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    async function init() {
      await loadScript(sdkUrl);
      const paypal = window.paypal;
      if (!paypal) throw new Error("window.paypal missing after script load");

      const base = {
        components: ["paypal-payments"],
        pageType: "checkout",
        clientMetadataId: crypto.randomUUID(),
      };
      let sdk: PayPalSdkInstance;
      try {
        sdk = await paypal.createInstance({ ...base, clientId });
        note("SDK initialised with clientId");
      } catch (e) {
        note(`clientId init refused (${(e as Error).message}); trying a client token`);
        const res = await fetch("/api/spike/client-token");
        const { clientToken } = (await res.json()) as { clientToken?: string };
        if (!clientToken) throw new Error("No client token from server");
        sdk = await paypal.createInstance({ ...base, clientToken });
        note("SDK initialised with clientToken");
      }

      const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
      if (!methods.isEligible("paypal")) {
        note("PayPal is not eligible for this browser/currency");
        return;
      }

      sessionRef.current = sdk.createPayPalOneTimePaymentSession({
        async onApprove({ orderId }) {
          note(`Buyer approved order ${orderId}; authorising on the server...`);
          const res = await fetch("/api/spike/authorize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId }),
          });
          const data = (await res.json()) as Record<string, unknown>;
          if (!res.ok) {
            note(`Authorise FAILED: ${JSON.stringify(data)}`);
            return;
          }
          note(
            `Funds held. Authorization ${String(data.authorizationId)} is ` +
              `${String(data.authorizationStatus)}, expires ${String(data.expirationTime)}`,
          );
        },
        onCancel() {
          note("Buyer cancelled");
        },
        onError(error: PayPalSdkError) {
          note(`SDK error ${error.code ?? ""}: ${error.message}`);
        },
      });

      if (sessionRef.current.hasReturned?.()) {
        note("Returned from a redirect; resuming the session");
        await sessionRef.current.resume?.();
      }
      setReady(true);
    }

    init().catch((e: unknown) => note(`Init failed: ${(e as Error).message}`));
  }, [clientId, sdkUrl]);

  async function pay() {
    const session = sessionRef.current;
    if (!session) return;
    try {
      await session.start({ presentationMode: "auto" }, createOrder());
    } catch (e) {
      const err = e as PayPalSdkError;
      if (err.code === "ERR_DEV_UNABLE_TO_OPEN_POPUP") {
        note("Popup blocked; retrying as a full-page redirect");
        await session.start({ presentationMode: "redirect" }, createOrder());
        return;
      }
      note(`Start failed ${err.code ?? ""}: ${err.message}`);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      {!clientId && <p className="text-red-600">NEXT_PUBLIC_PAYPAL_CLIENT_ID is not set.</p>}
      <paypal-button type="pay" hidden={!ready} onClick={pay} />
      {!ready && <p className="text-sm opacity-70">Loading PayPal...</p>}
      <pre className="overflow-x-auto rounded bg-neutral-100 p-3 text-xs whitespace-pre-wrap text-neutral-900">
        {log.join("\n") || "Log will appear here."}
      </pre>
    </section>
  );
}
