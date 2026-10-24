import { eq } from "drizzle-orm";
import { POST as createDealRoute } from "@/app/api/deals/route";
import { GET as getDealRoute } from "@/app/api/deals/[ref]/route";
import { POST as authorizeRoute } from "@/app/api/deals/[ref]/authorize/route";
import { POST as confirmRoute } from "@/app/api/deals/[ref]/confirm/route";
import { POST as evidenceRoute } from "@/app/api/deals/[ref]/evidence/route";
import { POST as orderRoute } from "@/app/api/deals/[ref]/order/route";
import { POST as adminLoginRoute } from "@/app/api/admin/login/route";
import { getDb } from "@/lib/db";
import { deals } from "@/lib/db/schema";
import { TERMS_INPUT } from "./factories";

// Helpers for route tests: requests with a party's token, and a deal taken through the routes to
// the point a test needs. The engine's PayPal must be faked first (setEngineDeps).

const db = getDb();

// 1×1 PNG.
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const ctx = (ref: string) => ({ params: Promise.resolve({ ref }) });
export const as = (token: string) => ({ "x-deal-token": token });

export type View = {
  state: string;
  termsHash: string;
  termsVersion: number;
  actions: string[];
  handover: { code: string | null; attemptsLeft: number; locked: boolean };
  extension: { id: string; proposedBy: string } | null;
  evidence: { id: string; type: string; photoPath: string | null; addedBy: string }[];
};

export async function view(ref: string, token: string) {
  const res = await getDealRoute(req("GET", undefined, as(token)), ctx(ref));
  return (await res.json()) as View;
}

/** A deal through the routes to AUTHORIZED (and SHIPPED with `ship`). */
export async function heldDeal(opts: { ship?: boolean; deliveryMethod?: string } = {}) {
  const created = await createDealRoute(
    req("POST", {
      sellerName: "David",
      buyerName: "Shemaya",
      terms: { ...TERMS_INPUT, deliveryMethod: opts.deliveryMethod ?? "courier" },
    }),
  );
  const { ref, links } = (await created.json()) as { ref: string; links: Record<string, string> };
  const token = (l: string) => decodeURIComponent(new URL(l).searchParams.get("t") as string);
  const d = { ref, seller: token(links.seller), buyer: token(links.buyer) };
  const { termsHash } = await view(d.ref, d.seller);
  await confirmRoute(req("POST", { termsHash }, as(d.seller)), ctx(d.ref));
  await confirmRoute(req("POST", { termsHash }, as(d.buyer)), ctx(d.ref));
  const order = (await (await orderRoute(req("POST", {}, as(d.buyer)), ctx(d.ref))).json()) as {
    id: string;
  };
  await authorizeRoute(req("POST", { orderId: order.id }, as(d.buyer)), ctx(d.ref));
  if (opts.ship) {
    await evidenceRoute(
      req("POST", { carrier: "G4S", trackingNumber: "G4S-777" }, as(d.seller)),
      ctx(d.ref),
    );
  }
  const [row] = await db.select().from(deals).where(eq(deals.publicRef, ref));
  return { ...d, id: row.id };
}

export const state = async (id: string) =>
  (await db.select().from(deals).where(eq(deals.id, id)))[0].state;

/** Log in as the reviewer; returns the session cookie to send. */
export async function adminCookie() {
  const res = await adminLoginRoute(req("POST", { password: "test-admin-password" }));
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
  return (res.headers.get("set-cookie") as string).split(";")[0];
}
