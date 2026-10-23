import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { dealForToken, dealView } from "@/lib/deals/service";
import { serverEnv } from "@/lib/env";
import DealRoom from "./DealRoom";

export const dynamic = "force-dynamic";
// Role links carry a secret token: keep them out of search engines and referrers.
export const metadata: Metadata = {
  title: "Deal Room · SafeDeal",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<{ t?: string }> };

export default async function DealPage({ params, searchParams }: Props) {
  const [{ ref }, { t }] = await Promise.all([params, searchParams]);
  const env = serverEnv();
  const db = getDb();
  const found = await dealForToken(db, ref, t ?? null);
  if (!found || !t) notFound();
  const view = await dealView(db, found.deal, found.role, {
    now: new Date(),
    timeScale: env.DEMO_TIME_SCALE,
    kesPerUsd: env.KES_PER_USD,
    appBaseUrl: env.APP_BASE_URL,
    handoverSecret: env.HANDOVER_SECRET,
    demoMode: env.DEMO_MODE && env.COURIER_MODE === "test",
  });
  return (
    <DealRoom
      initial={JSON.parse(JSON.stringify(view))}
      token={t}
      kesPerUsd={env.KES_PER_USD}
      paypal={{
        clientId: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "",
        sdkUrl:
          process.env.NEXT_PUBLIC_PAYPAL_SDK_URL ??
          "https://www.sandbox.paypal.com/web-sdk/v6/core",
      }}
    />
  );
}
