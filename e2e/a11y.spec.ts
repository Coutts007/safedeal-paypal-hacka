import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ENV } from "./env";
import {
  agree,
  createDeal,
  fakeLoginAs,
  payByApi,
  resetFakePaypal,
  stubPaypalSdk,
} from "./helpers";

// BUILD_PLAN Phase 6, item 5: every main screen, in the states people actually see, has no WCAG
// 2.1 A/AA problems axe can detect and no sideways scrolling at 360 px.

async function check(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${name}: horizontal overflow in px`).toBeLessThanOrEqual(0);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    violations.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
    ),
    name,
  ).toEqual([]);
}

test.beforeEach(async ({ request }) => resetFakePaypal(request));

test("home and create form", async ({ page }) => {
  await page.goto("/");
  await check(page, "home");
  await page.getByRole("button", { name: "Fill in the form by hand instead" }).click();
  await check(page, "create form");
  // Submitting an empty form shows the browser's own required-field message, not a page error.
  await page.getByRole("button", { name: "Create deal" }).click();
  await check(page, "create form after an empty submit");
});

test("Deal Room in each state, for both parties", async ({ page, request }) => {
  const d = await createDeal(request);
  await stubPaypalSdk(page);
  await page.goto(d.seller);
  await check(page, "seller, draft");
  await page.goto(d.buyer);
  await check(page, "buyer, draft");

  await agree(request, d);
  await page.goto(d.buyer);
  await expect(page.getByRole("button", { name: "PayPal" })).toBeVisible();
  await check(page, "buyer, agreed (pay button)");

  await payByApi(request, d);
  await page.goto(d.buyer);
  await check(page, "buyer, funds held (handover code)");
  await page.goto(d.seller);
  await page.getByRole("button", { name: "Enter the buyer's handover code" }).click();
  await check(page, "seller, funds held (tracking and handover forms)");

  await page.getByLabel("Tracking number").fill("G4S-A11Y-1");
  await page.getByRole("button", { name: "Add tracking" }).click();
  await expect(page.getByRole("main")).toContainText("Shipped.");
  await page.goto(d.buyer);
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page.getByRole("button", { name: "Add a photo or note for the reviewer" }).click();
  await check(page, "buyer, shipped (problem and evidence forms open)");

  await page.getByLabel(/^What is wrong\?/).fill("The box was empty when I opened it.");
  await page.getByRole("button", { name: "Send to a reviewer" }).click();
  await expect(page.getByRole("main")).toContainText("You reported a problem");
  await check(page, "buyer, in review");
  await page.goto(d.seller);
  await check(page, "seller, in review");
});

test("reviewer pages", async ({ page, request }) => {
  const d = await createDeal(request);
  await agree(request, d);
  await payByApi(request, d);
  await request.post(`/api/deals/${d.ref}/receipt`, {
    headers: { "x-deal-token": d.buyerToken },
    data: { action: "problem", note: "Never arrived." },
  });

  await page.goto("/admin");
  await check(page, "reviewer login");
  await page.getByLabel("Admin password").fill(E2E_ENV.ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("link", { name: new RegExp(d.ref) }).first()).toBeVisible();
  await check(page, "reviewer queue");
  await page
    .getByRole("link", { name: new RegExp(d.ref) })
    .first()
    .click();
  await expect(page.getByRole("heading").first()).toBeVisible();
  await check(page, "reviewer deal page");
});

test("seller login, dashboard and new deal pages", async ({ page, request }) => {
  for (const legal of ["/privacy", "/terms"]) {
    await page.goto(legal);
    await check(page, legal);
  }
  await page.goto("/login");
  await check(page, "seller login");
  await page.goto("/login?error=paypal");
  await check(page, "seller login with an error");
  await fakeLoginAs(request, {
    user_id: `a11y-${Date.now()}`,
    name: "A11y Shop",
    email: "seller-a@business.example.com",
  });
  await page.getByRole("button", { name: "Log in with PayPal" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  for (const tab of ["needs", "active", "done", "archived"]) {
    await page.goto(`/dashboard?tab=${tab}`);
    await check(page, `dashboard, ${tab}`);
  }
  await page.goto("/dashboard/new");
  await page.getByRole("button", { name: "Fill in the form by hand instead" }).click();
  await check(page, "new deal from the dashboard");
});
