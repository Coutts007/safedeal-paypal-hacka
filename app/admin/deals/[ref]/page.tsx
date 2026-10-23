import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { dealByRef } from "@/lib/admin/http";
import { adminDeal } from "@/lib/admin/queries";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { Card, nairobi, Notice } from "../../../components/ui";
import LogoutButton from "../../LogoutButton";
import { isAdmin, REVIEW_KIND } from "../../session";
import { AiCheck, Decision, Unlock } from "./AdminActions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Review · SafeDeal",
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ ref: string }> };

const when = (iso: string | null) => (iso ? nairobi(iso) : "—");

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-neutral-500">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function AdminDealPage({ params }: Props) {
  if (!(await isAdmin())) redirect("/admin");
  const { ref } = await params;
  const deal = await dealByRef(ref);
  if (!deal) notFound();
  const d = await adminDeal(getDb(), deal, {
    now: new Date(),
    timeScale: serverEnv().DEMO_TIME_SCALE,
  });
  const openReview = d.reviews.find((r) => !r.decision);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <Link href="/admin" className="text-sm text-emerald-700 underline">
            ← Review queue
          </Link>
          <LogoutButton />
        </div>
        <h1 className="text-2xl font-bold">
          {d.terms?.item ?? "Deal"} · {d.ref}
        </h1>
        <p className="text-sm">
          <strong>{d.state}</strong> · US${d.amount ?? "?"} · seller {d.names.seller ?? "?"} → buyer{" "}
          {d.names.buyer ?? "?"}
        </p>
      </header>

      {!d.chainOk && (
        <Notice tone="error">
          The audit log hash chain does not verify. Do not decide until this is explained.
        </Notice>
      )}
      {openReview && (
        <Notice tone="info">
          <strong>{REVIEW_KIND[openReview.kind] ?? openReview.kind}:</strong> {openReview.reason}
          {openReview.note && (
            <>
              <br />
              Buyer wrote: “{openReview.note}”
            </>
          )}
        </Notice>
      )}

      <Decision deal={d} />
      <Unlock deal={d} />
      <AiCheck deal={d} />

      <Card title="Delivery proof">
        <Rows
          rows={[
            ["Proof", d.handover.deliveryProof ?? "none yet"],
            ["Delivered at", when(d.handover.deliveredAt)],
            [
              "Handover code",
              d.handover.hasCode
                ? `${d.handover.attempts} wrong ${d.handover.attempts === 1 ? "try" : "tries"}${d.handover.locked ? ", locked" : ""}`
                : "none",
            ],
            ["Ship by", when(d.deadlines.shipBy)],
            ["Deliver by", when(d.deadlines.deliverBy)],
            ["Inspection ends", when(d.deadlines.inspectionEndsAt)],
            ["Authorised", when(d.deadlines.authorizedAt)],
            ["Day 26 review", when(d.deadlines.reviewAt)],
            ["Hold ends", when(d.deadlines.holdEndsAt)],
          ]}
        />
      </Card>

      <Card title={`Evidence (${d.evidence.length})`}>
        {d.evidence.length === 0 && <p className="text-sm text-neutral-500">None added.</p>}
        <ul className="flex flex-col gap-3 text-sm">
          {d.evidence.map((e) => (
            <li key={e.id} className="flex flex-col gap-1">
              <span className="text-xs text-neutral-500">
                {nairobi(e.createdAt)} · {e.type} from the {e.addedBy ?? "seller"}
              </span>
              {e.type === "tracking" && (
                <span>
                  {e.carrier} <span className="font-mono">{e.trackingNumber}</span>
                </span>
              )}
              {e.type === "note" && <span className="whitespace-pre-wrap">{e.note}</span>}
              {e.type === "photo" && (
                <a
                  href={`/api/admin/deals/${d.ref}/photos/${e.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- private, admin-only image */}
                  <img
                    src={`/api/admin/deals/${d.ref}/photos/${e.id}`}
                    alt={e.note ?? "Evidence photo"}
                    className="max-h-72 rounded-lg border border-neutral-200 object-contain"
                  />
                  {e.note && <span className="mt-1 block">{e.note}</span>}
                </a>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Courier events">
        {d.courierEvents.length === 0 ? (
          <p className="text-sm text-neutral-500">None received.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {d.courierEvents.map((c) => (
              <li key={c.eventId}>
                {nairobi(c.receivedAt)} · {c.status} · {c.trackingNumber}{" "}
                {c.verified ? "(signature verified)" : "(NOT verified)"}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {d.terms && (
        <Card title={`Confirmed terms (version ${d.termsVersion} of ${d.termsVersions})`}>
          <Rows
            rows={[
              ["Item", `${d.terms.quantity} × ${d.terms.item}`],
              ["Price", `US$${d.terms.price.amount}`],
              [
                "Delivery",
                `${d.terms.deliveryMethod}${d.terms.carrier ? ` (${d.terms.carrier})` : ""}`,
              ],
              ["Conditions", d.terms.conditions.length ? d.terms.conditions.join("; ") : "none"],
              ["Inspection", `${d.terms.inspectionHours} h`],
              ["Paid to", d.payeeEmail ?? d.terms.payeeEmail],
            ]}
          />
        </Card>
      )}

      {d.extensions.length > 0 && (
        <Card title="Delivery date changes">
          <ul className="flex flex-col gap-1 text-sm">
            {d.extensions.map((x) => (
              <li key={x.createdAt}>
                {nairobi(x.createdAt)} · {x.proposedBy} proposed {when(x.newDeliverBy)} (was{" "}
                {when(x.oldDeliverBy)}) · {x.status}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Reviews">
        <ul className="flex flex-col gap-2 text-sm">
          {d.reviews.map((r) => (
            <li key={r.createdAt}>
              {nairobi(r.createdAt)} · {REVIEW_KIND[r.kind] ?? r.kind}: {r.reason}
              {r.decision && (
                <span className="text-neutral-500">
                  {" "}
                  → {r.decision} by {r.decidedBy}
                  {r.decidedAt ? ` at ${nairobi(r.decidedAt)}` : ""}
                  {r.note && r.decision !== "cleared" ? ` (“${r.note}”)` : ""}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="PayPal">
        <ul className="flex flex-col gap-1 font-mono text-xs break-all">
          {d.payments.map((p) => (
            <li key={p.orderId}>
              attempt {p.attempt} · order {p.orderId} · auth {p.authorizationId ?? "—"} · capture{" "}
              {p.captureId ?? "—"} · {p.status}
            </li>
          ))}
        </ul>
      </Card>

      {d.chat.length > 0 && (
        <Card title="Chat the deal came from (redacted)">
          {d.chatFlags.length > 0 && (
            <p className="mb-2 text-sm text-amber-800">
              Flagged as instructions to the AI (ignored):{" "}
              {d.chatFlags.map((f) => f.messageId).join(", ")}
            </p>
          )}
          <ol className="flex flex-col gap-1 text-xs">
            {d.chat.map((m) => (
              <li key={m.id}>
                <span className="font-mono text-neutral-500">[{m.id}]</span>{" "}
                {m.from && <span className="font-medium">{m.from}: </span>}
                <span className="whitespace-pre-wrap">{m.text}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Card
        title={`Audit log (${d.audit.length} entries, chain ${d.chainOk ? "verified" : "BROKEN"})`}
      >
        <ol className="flex flex-col gap-1 text-xs">
          {d.audit.map((a) => (
            <li
              key={a.id}
              className="flex flex-col border-b border-neutral-100 pb-1 dark:border-neutral-800"
            >
              <span>
                <span className="text-neutral-500">{nairobi(a.at)}</span> · {a.actor} ·{" "}
                <span className="font-medium">{a.action}</span>
              </span>
              <span className="font-mono break-all text-neutral-600 dark:text-neutral-400">
                {JSON.stringify(a.details)} · #{a.hash}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </main>
  );
}
