import { expect, test, type Page } from "@playwright/test";
import { DEMO_TIME_SCALE, E2E_ENV, FAKE_PAYPAL } from "./env";
import {
  agree,
  createDeal,
  fakeAuths,
  fakeCalls,
  payByApi,
  resetFakePaypal,
  SELLER_EMAIL,
  stubPaypalSdk,
  sweep,
  view,
  waitForState,
} from "./helpers";

// BUILD_PLAN Phase 6, item 3: the money paths end to end in a 360 px browser, against a
// production build, a real database and a fake PayPal (see playwright.config.ts).

const CAPTURE_ID = /^deal-[0-9a-f-]{36}-capture-v1$/;
const VOID_ID = /^deal-[0-9a-f-]{36}-void-v1$/;
const status = (page: Page) => page.getByRole("main");

test.beforeEach(async ({ request }) => resetFakePaypal(request));

test("capture path: chat-free deal by hand → both confirm → pay → tracking → delivered → buyer confirms → seller paid", async ({
  page,
  browser,
  request,
}) => {
  // Seller creates the deal on the home page.
  await page.goto("/");
  await page.getByLabel("Your name").fill("David");
  await page.getByLabel("Buyer's name").fill("Shemaya");
  await page.getByRole("button", { name: "Fill in the form by hand instead" }).click();
  await page.getByLabel("Item", { exact: true }).fill("Tecno Spark 20, 128GB");
  await page.getByLabel(/^Price \(USD\)/).fill("95.00");
  await page.getByLabel("Carrier", { exact: true }).fill("G4S");
  await page.getByLabel(/^Seller's PayPal email/).fill(SELLER_EMAIL);
  await page.getByRole("button", { name: "Create deal" }).click();
  await expect(page.getByText("Deal created")).toBeVisible();
  const buyerLink = (await page.locator("code").first().textContent()) as string;
  await page.getByRole("link", { name: "Open my deal page" }).click();
  await page.getByRole("button", { name: "Confirm these terms" }).click();
  await expect(page.getByText(/You confirmed these terms/)).toBeVisible();

  // Buyer confirms and pays in their own browser.
  const buyerCtx = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const buyer = await buyerCtx.newPage();
  await stubPaypalSdk(buyer);
  await buyer.goto(new URL(buyerLink).pathname + new URL(buyerLink).search);
  await buyer.getByRole("button", { name: "Confirm these terms" }).click();
  await expect(status(buyer)).toContainText("Pay with PayPal: the money is held");
  await buyer.getByRole("button", { name: "PayPal" }).click();
  await expect(status(buyer)).toContainText("Funds are held by PayPal");

  // Seller ships.
  await page.reload();
  await page.getByLabel("Tracking number").fill("G4S-E2E-001");
  await page.getByRole("button", { name: "Add tracking" }).click();
  await expect(status(page)).toContainText("Shipped.");

  // The test courier reports delivery (signed, verified).
  const delivered = await request.post("/api/test-courier/deliver", {
    headers: { "x-test-courier-secret": E2E_ENV.TEST_COURIER_SECRET },
    data: { trackingNumber: "G4S-E2E-001" },
  });
  expect(await delivered.json()).toMatchObject({ matched: true, result: { to: "DELIVERED" } });

  // Buyer confirms receipt: the engine captures.
  await buyer.reload();
  await expect(status(buyer)).toContainText("Delivered.");
  await buyer.getByRole("button", { name: "I received it: pay the seller" }).click();
  await expect(status(buyer)).toContainText("Done. The seller has been paid.");
  await page.reload();
  await expect(status(page)).toContainText("Done. PayPal has paid you.");

  const calls = await fakeCalls(request);
  const created = calls.filter((c) => c.path === "/v2/checkout/orders");
  expect(created).toHaveLength(1);
  expect(created[0].body).toMatchObject({
    intent: "AUTHORIZE",
    purchase_units: [
      { amount: { currency_code: "USD", value: "95.00" }, payee: { email_address: SELLER_EMAIL } },
    ],
  });
  const captures = calls.filter((c) => c.path.endsWith("/capture"));
  expect(captures).toHaveLength(1);
  expect(captures[0].requestId).toMatch(CAPTURE_ID);
  expect(calls.filter((c) => c.path.endsWith("/void"))).toEqual([]);
  await buyerCtx.close();
});

test("void path: the seller never ships, the sweep releases the hold after ship-by", async ({
  page,
  request,
}) => {
  const d = await createDeal(request);
  await agree(request, d);
  await payByApi(request, d);

  // Before ship-by the sweep changes nothing.
  await sweep(request);
  expect((await view(request, d.ref, d.buyerToken)).state).toBe("AUTHORIZED");

  // 48 h in demo time, plus a margin.
  await page.waitForTimeout((48 * 3_600_000) / DEMO_TIME_SCALE + 2_000);
  await sweep(request);
  await waitForState(request, d, "VOIDED");

  await page.goto(d.buyer);
  await expect(status(page)).toContainText("The hold was released, so you have not been charged.");
  await page.goto(d.seller);
  await expect(status(page)).toContainText("The hold was released to the buyer");

  const calls = await fakeCalls(request);
  const voids = calls.filter((c) => c.path.endsWith("/void"));
  expect(voids).toHaveLength(1);
  expect(voids[0].requestId).toMatch(VOID_ID);
  expect(calls.filter((c) => c.path.endsWith("/capture"))).toEqual([]);
  // A second sweep does not void again.
  await sweep(request);
  expect((await fakeCalls(request)).filter((c) => c.path.endsWith("/void"))).toHaveLength(1);
});

test("duplicate webhook: a verified PayPal event acts once; the repeat and a forged one do nothing", async ({
  request,
}) => {
  const d = await createDeal(request);
  await agree(request, d);
  await payByApi(request, d);
  const [auth] = await fakeAuths(request);
  // PayPal ended the hold itself (e.g. at expiry), then tells us.
  await request.post(`${FAKE_PAYPAL}/__auths/${auth.id}`, { data: { status: "VOIDED" } });

  const event = {
    id: "WH-E2E-0001",
    event_type: "PAYMENT.AUTHORIZATION.VOIDED",
    resource: { id: auth.id },
  };
  const headers = (sig: string) => ({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-e2e",
    "paypal-transmission-id": `tx-${sig}`,
    "paypal-transmission-sig": sig,
    "paypal-transmission-time": new Date().toISOString(),
    "content-type": "application/json",
  });
  const forged = await request.post("/api/webhooks/paypal", {
    headers: headers("bad-signature"),
    data: { ...event, id: "WH-E2E-FORGED" },
  });
  expect(forged.status()).toBe(400);

  const first = await request.post("/api/webhooks/paypal", {
    headers: headers("sig-1"),
    data: event,
  });
  expect(await first.json()).toEqual({ received: true });
  await waitForState(request, d, "EXPIRED");

  const repeat = await request.post("/api/webhooks/paypal", {
    headers: headers("sig-2"),
    data: event,
  });
  expect(await repeat.json()).toEqual({ received: true, duplicate: true });

  const v = await view(request, d.ref, d.buyerToken);
  expect(v.statusLine).toContain("released back to you");
  expect(v.history.filter((h) => h.label.endsWith("→ EXPIRED"))).toHaveLength(1);
});

test("popup blocked: the buyer is sent to PayPal by redirect instead, and the payment is held", async ({
  page,
  request,
}) => {
  const d = await createDeal(request);
  await agree(request, d);
  await stubPaypalSdk(page, { popupBlocked: true });
  await page.goto(d.buyer);
  await page.getByRole("button", { name: "PayPal" }).click();
  await expect(status(page)).toContainText("Funds are held by PayPal");
  const log = await page.evaluate(
    () =>
      (window as unknown as { __paypalStubLog: { step: string; presentationMode?: string }[] })
        .__paypalStubLog,
  );
  expect(log.filter((l) => l.step === "start").map((l) => l.presentationMode)).toEqual([
    "auto",
    "redirect",
  ]);
  // Both attempts used the same PayPal order.
  expect((await fakeCalls(request)).filter((c) => c.path === "/v2/checkout/orders")).toHaveLength(
    1,
  );
});

test("price tampering: an amount or payee edited in the browser is ignored", async ({
  page,
  request,
}) => {
  const d = await createDeal(request);
  await agree(request, d);
  // After both confirmed, the terms are locked.
  const edit = await request.post(`/api/deals/${d.ref}/terms`, {
    headers: { "x-deal-token": d.buyerToken },
    data: { terms: { price: { amount: "1.00", currency: "USD" } } },
  });
  expect(edit.status()).toBeGreaterThanOrEqual(400);

  // The buyer's browser rewrites the order request.
  await stubPaypalSdk(page);
  await page.route("**/api/deals/*/order", (route) =>
    route.continue({
      postData: JSON.stringify({
        amount: "1.00",
        value: "1.00",
        payeeEmail: "attacker@example.com",
        purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }],
      }),
    }),
  );
  await page.goto(d.buyer);
  await page.getByRole("button", { name: "PayPal" }).click();
  await expect(status(page)).toContainText("Funds are held by PayPal");

  const [order] = (await fakeCalls(request)).filter((c) => c.path === "/v2/checkout/orders");
  expect(order.body).toMatchObject({
    purchase_units: [{ amount: { value: "95.00" }, payee: { email_address: SELLER_EMAIL } }],
  });
  expect(JSON.stringify(order.body)).not.toContain("attacker");
  expect((await view(request, d.ref, d.buyerToken)).amount).toBe("95.00");
});

test("a refused payment shows a plain message and can be tried again", async ({
  page,
  request,
}) => {
  const d = await createDeal(request);
  await agree(request, d);
  await request.post(`${FAKE_PAYPAL}/__fail`, { data: { authorize: "TRANSACTION_REFUSED" } });
  await stubPaypalSdk(page);
  await page.goto(d.buyer);
  await page.getByRole("button", { name: "PayPal" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("PayPal refused this payment");
  await expect(status(page)).toContainText("PayPal could not hold the money");

  // The retry uses a new order and goes through.
  await page.reload();
  await page.getByRole("button", { name: "PayPal" }).click();
  await expect(status(page)).toContainText("Funds are held by PayPal");
  expect((await fakeCalls(request)).filter((c) => c.path === "/v2/checkout/orders")).toHaveLength(
    2,
  );
});
