import { expect, test } from "@playwright/test";
import { E2E_ENV } from "./env";
import { agree, dealFromLinks, fakeLoginAs, payByApi, resetFakePaypal } from "./helpers";

// Phase 6b end to end: a seller logs in with PayPal (the fake PayPal signs them in), creates a
// deal from the dashboard, and follows it through Needs you, In progress and Finished to Archived.

test.beforeEach(async ({ request }) => resetFakePaypal(request));

test("seller logs in with PayPal, creates a deal from the dashboard, ships it and archives it", async ({
  page,
  request,
}) => {
  // A fresh PayPal account, so deals of earlier tests (paid to other emails) are not added.
  const email = `shop-${Date.now()}@business.example.com`;
  await fakeLoginAs(request, { user_id: `e2e-${Date.now()}`, name: "Mama Mboga Shop", email });

  await page.goto("/");
  await page.getByRole("link", { name: "Log in with PayPal" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("link", { name: "Log in with PayPal" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "My deals" })).toBeVisible();
  await expect(page.locator("main header")).toContainText(`Mama Mboga Shop · ${email}`);
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();

  // New deal: the payout email is the PayPal account's, not typed.
  await page.getByRole("link", { name: "Start a new deal" }).click();
  await expect(page.getByLabel("Your name")).toHaveValue("Mama Mboga Shop");
  await page.getByLabel("Buyer's name").fill("Shemaya");
  await page.getByRole("button", { name: "Fill in the form by hand instead" }).click();
  await expect(page.getByText(`Paid to your PayPal account ${email}`)).toBeVisible();
  await expect(page.getByLabel(/^Seller's PayPal email/)).toHaveCount(0);
  await page.getByLabel("Item", { exact: true }).fill("Sukuma wiki, 10 bunches");
  await page.getByLabel(/^Price \(USD\)/).fill("12.00");
  await page.getByRole("button", { name: "Create deal" }).click();
  await expect(page.getByText("Deal created")).toBeVisible();
  const buyerLink = (await page.locator("code").first().textContent()) as string;
  const sellerLink = (await page
    .getByRole("link", { name: "Open my deal page" })
    .getAttribute("href")) as string;
  const ref = new URL(buyerLink).pathname.split("/").pop() as string;
  const d = dealFromLinks(ref, sellerLink, buyerLink);

  await page.getByRole("link", { name: "Back to my deals" }).first().click();
  const row = page.getByRole("listitem").filter({ hasText: "Sukuma wiki" });
  await expect(row).toContainText("Confirm the terms");
  await expect(row).toContainText("US$12.00");

  // Both confirm and the buyer pays: the deal needs shipping, and the money shows as on hold.
  await agree(request, d);
  await payByApi(request, d);
  await page.reload();
  await expect(row).toContainText("Paid: ship it and add tracking");
  await expect(row).toContainText("Ship by");
  await expect(page.getByLabel("Totals")).toContainText("US$12.00");

  // Open from the dashboard: the Deal Room as the seller.
  await row.getByRole("link", { name: `Open deal ${ref}` }).click();
  await page.getByLabel("Tracking number").fill(`G4S-DASH-${ref}`);
  await page.getByRole("button", { name: "Add tracking" }).click();
  await expect(page.getByRole("main")).toContainText("Shipped.");
  await page.goto("/dashboard?tab=active");
  await expect(row).toBeVisible();

  // Delivered and confirmed: Finished, then archived (hidden, not changed).
  await request.post("/api/test-courier/deliver", {
    headers: { "x-test-courier-secret": E2E_ENV.TEST_COURIER_SECRET },
    data: { trackingNumber: `G4S-DASH-${ref}` },
  });
  const confirm = await request.post(`/api/deals/${ref}/receipt`, {
    headers: { "x-deal-token": d.buyerToken },
    data: { action: "confirm" },
  });
  expect(confirm.ok()).toBe(true);
  await page.goto("/dashboard?tab=done");
  await expect(row).toContainText("Done. PayPal has paid you.");
  await expect(page.getByLabel("Totals")).toContainText("Paid to you");
  await row.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("No finished deals yet.")).toBeVisible();
  await page.getByRole("link", { name: /^Archived/ }).click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Move back to Finished" }).click();
  await expect(page.getByText(/Nothing archived/)).toBeVisible();

  // Log out: the dashboard asks to log in again.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
});

test("a login PayPal did not send back here is refused", async ({ page }) => {
  await page.goto("/api/auth/paypal/callback?code=stolen&state=forged");
  await expect(page).toHaveURL(/\/login\?error=expired$/);
  await expect(page.getByText(/That login took too long/)).toBeVisible();
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
});
