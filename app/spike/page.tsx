import { notFound } from "next/navigation";
import SpikeCheckout from "./SpikeCheckout";

export const metadata = { title: "Payment spike · SafeDeal" };

// Phase 1 only: proves the SDK v6 button accepts an order created server-side with intent
// AUTHORIZE. Not available in production builds.
export default function SpikePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-bold">Payment spike</h1>
      <p>
        Pays 12.00 USD to sandbox seller A with intent <code>AUTHORIZE</code>. Log in as the sandbox
        buyer. The money is held, not captured.
      </p>
      <SpikeCheckout
        clientId={process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? ""}
        sdkUrl={
          process.env.NEXT_PUBLIC_PAYPAL_SDK_URL ?? "https://www.sandbox.paypal.com/web-sdk/v6/core"
        }
      />
    </main>
  );
}
