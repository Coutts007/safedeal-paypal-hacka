import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { serverEnv } from "@/lib/env";
import CreateDeal from "../../CreateDeal";
import { currentAccount } from "../session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "New deal · SafeDeal",
  robots: { index: false, follow: false },
};

export default async function NewDealPage() {
  const account = await currentAccount();
  if (!account) redirect("/login");
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">New deal</h1>
        <Link
          href="/dashboard"
          className="text-sm text-emerald-700 underline dark:text-emerald-400"
        >
          Back to my deals
        </Link>
      </header>
      <CreateDeal
        kesPerUsd={serverEnv().KES_PER_USD}
        account={{ name: account.name, email: account.email }}
      />
    </main>
  );
}
