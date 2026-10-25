import Link from "next/link";
import { serverEnv } from "@/lib/env";
import CreateDeal from "./CreateDeal";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">SafeDeal</h1>
        <p className="text-lg">
          Agreed a deal in chat? Pay with PayPal and the money stays on hold until delivery is
          proven. If the seller never ships, the hold is released automatically.
        </p>
        <p className="text-sm text-neutral-500">
          PayPal sandbox demo. Paste or upload your chat and the AI fills in the deal; you both
          confirm it.
        </p>
        <p className="text-sm">
          Selling often? Keep all your deals in one place on the{" "}
          <Link
            href="/login"
            className="font-medium text-emerald-700 underline dark:text-emerald-400"
          >
            seller dashboard
          </Link>
          .
        </p>
      </header>
      <CreateDeal kesPerUsd={serverEnv().KES_PER_USD} />
    </main>
  );
}
