import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { dashboard, type DashboardDeal } from "@/lib/accounts/service";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { Card, nairobi } from "../components/ui";
import { ArchiveButton, SellerLogout } from "./SellerButtons";
import { currentAccount } from "./session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "My deals · SafeDeal",
  robots: { index: false, follow: false },
};

const TABS = [
  { key: "needs", label: "Needs you", empty: "Nothing needs you right now." },
  { key: "active", label: "In progress", empty: "No deals in progress." },
  { key: "done", label: "Finished", empty: "No finished deals yet." },
  {
    key: "archived",
    label: "Archived",
    empty: "Nothing archived. Archive finished deals to tidy this list.",
  },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const account = await currentAccount();
  if (!account) redirect("/login");
  const env = serverEnv();
  const { lists, totals } = await dashboard(getDb(), account, {
    now: new Date(),
    timeScale: env.DEMO_TIME_SCALE,
    kesPerUsd: env.KES_PER_USD,
    appBaseUrl: env.APP_BASE_URL,
  });
  const asked = (await searchParams).tab;
  const tab: Tab = TABS.some((t) => t.key === asked)
    ? (asked as Tab)
    : lists.needs.length || !totals.count
      ? "needs"
      : "active";
  const current = TABS.find((t) => t.key === tab)!;
  const rows = lists[tab];

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-4 py-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">My deals</h1>
          <p className="truncate text-sm text-neutral-600 dark:text-neutral-400">
            {account.name ? `${account.name} · ` : ""}
            {account.email}
          </p>
        </div>
        <SellerLogout />
      </header>

      <section aria-label="Totals" className="grid grid-cols-3 gap-2 text-center">
        <Stat label="On hold" value={`US$${totals.onHold}`} />
        <Stat label="Paid to you" value={`US$${totals.paidOut}`} />
        <Stat label="Deals" value={String(totals.count)} />
      </section>

      <Link
        href="/dashboard/new"
        className="min-h-11 rounded-xl bg-emerald-600 px-4 py-2 text-center font-medium text-white transition hover:bg-emerald-700 active:scale-[0.98] active:bg-emerald-800"
      >
        Start a new deal
      </Link>

      <nav aria-label="Deal lists" className="flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/dashboard?tab=${t.key}`}
            aria-current={t.key === tab ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 text-sm whitespace-nowrap ${
              t.key === tab
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "bg-neutral-100 text-neutral-800 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
            }`}
          >
            {t.label} ({lists[t.key].length})
          </Link>
        ))}
      </nav>

      <Card title={current.label}>
        {rows.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{current.empty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
            {rows.map((d) => (
              <DealRow key={d.ref} deal={d} />
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-neutral-500">
        Deals made before you logged in appear here when they pay out to {account.email}. Archived
        deals are only hidden: their records and evidence bundle stay available.
      </p>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-xs text-neutral-600 dark:text-neutral-400">{label}</p>
      <p className="font-semibold">{value}</p>
    </div>
  );
}

function DealRow({ deal: d }: { deal: DashboardDeal }) {
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium break-words">{d.item}</p>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {d.buyer ? `To ${d.buyer} · ` : ""}
            {d.amount ? `US$${d.amount}` : "No price yet"} · {d.ref}
          </p>
        </div>
        <Link
          href={d.path}
          className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-700"
          aria-label={`Open deal ${d.ref}`}
        >
          Open
        </Link>
      </div>
      <p
        className={`text-sm ${d.group === "needs" ? "font-medium text-amber-900 dark:text-amber-200" : ""}`}
      >
        {d.todo}
      </p>
      {d.next && (
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          {d.next.label} {nairobi(d.next.at)}
        </p>
      )}
      {(d.group === "done" || d.group === "archived") && (
        <div className="max-w-56">
          <ArchiveButton reference={d.ref} archived={d.group === "archived"} />
        </div>
      )}
    </li>
  );
}
