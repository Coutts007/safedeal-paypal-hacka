import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_ENV, FAKE_PAYPAL, SDK_URL } from "./env";

// Shared steps for the end-to-end tests.

export type FakeCall = { method: string; path: string; requestId: string | null; body: unknown };
export type FakeAuth = { id: string; status: string; orderId: string; ref: string };

export const SELLER_EMAIL = "seller-a@business.example.com";

export async function resetFakePaypal(request: APIRequestContext) {
  await request.post(`${FAKE_PAYPAL}/__reset`);
}

export async function fakeCalls(request: APIRequestContext): Promise<FakeCall[]> {
  return (await request.get(`${FAKE_PAYPAL}/__calls`)).json();
}

export async function fakeAuths(request: APIRequestContext): Promise<FakeAuth[]> {
  return (await request.get(`${FAKE_PAYPAL}/__auths`)).json();
}

/** Serve the PayPal SDK stub instead of PayPal's script; options as window.__paypalStub. */
export async function stubPaypalSdk(page: Page, options: { popupBlocked?: boolean } = {}) {
  await page.addInitScript((o) => {
    (window as unknown as { __paypalStub: unknown }).__paypalStub = o;
  }, options);
  await page.route(`${SDK_URL}**`, (route) =>
    route.fulfill({ path: "e2e/paypal-sdk-stub.js", contentType: "application/javascript" }),
  );
}

export const tokenOf = (link: string) => new URL(link).searchParams.get("t") as string;
const path = (link: string) => {
  const u = new URL(link);
  return `${u.pathname}${u.search}`;
};

export type Deal = {
  ref: string;
  seller: string;
  buyer: string;
  sellerToken: string;
  buyerToken: string;
};

/** A deal from the links shown after creating it. */
export const dealFromLinks = (ref: string, seller: string, buyer: string): Deal => ({
  ref,
  seller: path(seller),
  buyer: path(buyer),
  sellerToken: tokenOf(seller),
  buyerToken: tokenOf(buyer),
});

/** Who signs in at the fake PayPal's Log in with PayPal page next. */
export async function fakeLoginAs(
  request: APIRequestContext,
  profile: { user_id: string; name: string; email: string },
) {
  const res = await request.post(`${FAKE_PAYPAL}/__login`, { data: profile });
  expect(res.ok()).toBe(true);
}

/** Create a deal through the API (not the subject of the test) with US$95 terms. */
export async function createDeal(
  request: APIRequestContext,
  terms: Record<string, unknown> = {},
): Promise<Deal> {
  const res = await request.post("/api/deals", {
    data: {
      sellerName: "David",
      buyerName: "Shemaya",
      terms: {
        item: "Tecno Spark 20, 128GB",
        quantity: 1,
        price: { amount: "95.00", currency: "USD" },
        deliveryMethod: "courier",
        carrier: "G4S",
        shipBy: null,
        deliverBy: null,
        conditions: [],
        payeeEmail: SELLER_EMAIL,
        ...terms,
      },
    },
  });
  expect(res.status()).toBe(201);
  const { ref, links } = (await res.json()) as { ref: string; links: Record<string, string> };
  return {
    ref,
    seller: path(links.seller),
    buyer: path(links.buyer),
    sellerToken: tokenOf(links.seller),
    buyerToken: tokenOf(links.buyer),
  };
}

export async function view(request: APIRequestContext, ref: string, token: string) {
  const res = await request.get(`/api/deals/${ref}`, { headers: { "x-deal-token": token } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as {
    state: string;
    termsHash: string;
    amount: string;
    statusLine: string;
    history: { label: string }[];
  };
}

/** Both parties confirm the current terms through the API. */
export async function agree(request: APIRequestContext, d: Deal) {
  const { termsHash } = await view(request, d.ref, d.sellerToken);
  for (const token of [d.sellerToken, d.buyerToken]) {
    const res = await request.post(`/api/deals/${d.ref}/confirm`, {
      headers: { "x-deal-token": token },
      data: { termsHash },
    });
    expect(res.ok()).toBe(true);
  }
  expect((await view(request, d.ref, d.buyerToken)).state).toBe("AGREED");
}

/** Pay as the buyer without the browser: create the order, then authorise it. */
export async function payByApi(request: APIRequestContext, d: Deal) {
  const headers = { "x-deal-token": d.buyerToken };
  const order = await request.post(`/api/deals/${d.ref}/order`, { headers, data: {} });
  const { id } = (await order.json()) as { id: string };
  const auth = await request.post(`/api/deals/${d.ref}/authorize`, {
    headers,
    data: { orderId: id },
  });
  expect(await auth.json()).toMatchObject({ outcome: "moved", to: "AUTHORIZED" });
}

export async function sweep(request: APIRequestContext) {
  const res = await request.post("/api/cron/sweep", {
    headers: { "x-cron-secret": E2E_ENV.CRON_SECRET },
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** Wait (polling the API) until the deal reaches a state. */
export async function waitForState(
  request: APIRequestContext,
  d: Deal,
  state: string,
  timeout = 15_000,
) {
  await expect
    .poll(async () => (await view(request, d.ref, d.buyerToken)).state, { timeout })
    .toBe(state);
}
