import type { Metadata } from "next";
import Link from "next/link";
import { adminQueue } from "@/lib/admin/queries";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { Card, nairobi } from "../components/ui";
import AdminLogin from "./AdminLogin";
import LogoutButton from "./LogoutButton";
import { isAdmin, REVIEW_KIND } from "./session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Reviewer · SafeDeal",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  if (!(await isAdmin())) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 px-4 py-6">
        <h1 className="text-2xl font-bold">SafeDeal reviewer</h1>
        <AdminLogin configured={Boolean(serverEnv().ADMIN_PASSWORD)} />
      </main>
    );
  }
  const { open, locked, recent } = await adminQueue(getDb());
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Review queue</h1>
        <LogoutButton />
      </header>
      <p className="text-sm text-neutral-500">
        Money stays held while a deal waits here. Every decision needs a written reason and is
        carried out by the rule engine.
      </p>

      <Card title={`Waiting for a decision (${open.length})`}>
        {open.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing to review.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
            {open.map((r) => (
              <li key={`${r.ref}-${r.openedAt.toISOString()}`} className="py-2">
                <Link href={`/admin/deals/${r.ref}`} className="flex flex-col gap-0.5">
                  <span className="font-medium text-emerald-700 underline">
                    {r.ref} · {REVIEW_KIND[r.kind] ?? r.kind}
                  </span>
                  <span>{r.reason}</span>
                  <span className="text-xs text-neutral-500">
                    {r.state} · US${r.amount ?? "?"} · opened {nairobi(r.openedAt.toISOString())}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {locked.length > 0 && (
        <Card title="Handover code locked (5 wrong codes)">
          <ul className="flex flex-col gap-2 text-sm">
            {locked.map((d) => (
              <li key={d.ref}>
                <Link href={`/admin/deals/${d.ref}`} className="text-emerald-700 underline">
                  {d.ref}
                </Link>{" "}
                · {d.state} · US${d.amount ?? "?"} · {nairobi(d.at.toISOString())}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Latest deals">
        <ul className="flex flex-col gap-1 text-sm">
          {recent.map((d) => (
            <li key={d.ref} className="flex flex-wrap justify-between gap-x-3">
              <Link href={`/admin/deals/${d.ref}`} className="text-emerald-700 underline">
                {d.ref}
              </Link>
              <span>
                {d.state} · US${d.amount ?? "-"} · {d.seller ?? "?"} → {d.buyer ?? "?"}
              </span>
              <span className="text-neutral-500">{nairobi(d.updatedAt.toISOString())}</span>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
