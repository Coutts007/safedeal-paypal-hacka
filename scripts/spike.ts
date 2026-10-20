/**
 * Phase 1 payment spike, the go/no-go test. Run with: npm run spike
 *
 * Proves in the sandbox that an AUTHORIZE order paid to a separate seller (payee) can be
 * authorised, captured once (and only once) and, on a second order, voided.
 * Prints ids, statuses and PayPal debug ids only: no secrets, tokens or emails.
 *
 * `npm run spike -- --self-payee` omits the payee (money goes to the app's own business account):
 * a control run to tell a payee problem apart from a buyer-approval problem.
 *
 * This is the one place outside lib/rules/engine.ts that calls capture/void, because it exists
 * to test those calls before the engine is built. It is never imported by the app.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { serverEnv } from "../lib/env";
import { paypalFetch, type PaypalResponse } from "../lib/paypal/client";
import {
  approvalLink,
  buildSpikeOrder,
  firstAuthorization,
  type AuthorizedOrder,
} from "../lib/paypal/spike";

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function describe(res: PaypalResponse): string {
  const body = res.json as { name?: string; details?: { issue?: string }[] };
  const issue = body.details?.[0]?.issue ?? body.name ?? "";
  return `HTTP ${res.status}${issue ? ` ${issue}` : ""}, debug_id ${res.debugId ?? "n/a"}`;
}

const selfPayee = process.argv.includes("--self-payee");
const payeeLabel = selfPayee ? "app's own account (no payee)" : "seller A";

const rl = createInterface({ input: process.stdin, output: process.stdout });

/** Create an AUTHORIZE order, let Peter approve it as the buyer, then authorise it. */
async function createApproveAuthorize(runId: string, label: string) {
  const env = serverEnv();
  console.log(`\n== Order ${label}: create (intent AUTHORIZE, 12.00 USD, payee = ${payeeLabel})`);
  const created = await paypalFetch<AuthorizedOrder & { links?: { href: string; rel: string }[] }>(
    "/v2/checkout/orders",
    {
      method: "POST",
      requestId: `spike-${runId}-${label}-create-v1`,
      body: buildSpikeOrder(selfPayee ? null : env.SANDBOX_SELLER_A_EMAIL, `spike-${label}`, {
        returnUrl: `${env.APP_BASE_URL}/spike/returned?result=approved`,
        cancelUrl: `${env.APP_BASE_URL}/spike/returned?result=cancelled`,
      }),
    },
  );
  check(`${label}: order created`, created.ok, `${created.json.id ?? "-"}, ${describe(created)}`);
  if (!created.ok) return undefined;

  const payee = created.json.purchase_units?.[0]?.payee;
  if (!selfPayee) {
    check(
      `${label}: payee is seller A`,
      payee?.email_address?.toLowerCase() === env.SANDBOX_SELLER_A_EMAIL.toLowerCase(),
      `merchant_id ${payee?.merchant_id ?? "not returned"}`,
    );
  }

  const link = approvalLink(created.json);
  if (!link) {
    check(`${label}: approval link returned`, false);
    return undefined;
  }
  console.log(`\n  Open this link, log in as the SANDBOX BUYER and approve:\n\n  ${link}\n`);
  console.log(
    `  (After approving you land on ${env.APP_BASE_URL}/spike/returned. If the dev server is not` +
      " running that page will not load, which is fine.)",
  );
  // Wait until PayPal reports APPROVED; pressing Enter early just re-checks.
  let status = "";
  for (;;) {
    const answer = await rl.question("  Press Enter once you have approved (or type skip)... ");
    const order = await paypalFetch<AuthorizedOrder>(`/v2/checkout/orders/${created.json.id}`);
    status = order.json.status;
    if (status === "APPROVED" || answer.trim().toLowerCase() === "skip") break;
    console.log(
      `  Order is ${status}, not APPROVED yet. Finish on the PayPal page: log in as the buyer and` +
        " click Continue / Pay. If PayPal shows an error, note its exact text.",
    );
  }
  check(`${label}: order approved by buyer`, status === "APPROVED", status);
  if (status !== "APPROVED") return undefined;

  const authorized = await paypalFetch<AuthorizedOrder>(
    `/v2/checkout/orders/${created.json.id}/authorize`,
    { method: "POST", requestId: `spike-${runId}-${label}-authorize-v1`, body: {} },
  );
  const auth = firstAuthorization(authorized.json);
  check(
    `${label}: authorised`,
    authorized.ok && auth?.status === "CREATED",
    `${auth?.id ?? "-"} ${auth?.status ?? ""}, expires ${auth?.expiration_time ?? "?"}, ${describe(authorized)}`,
  );
  return auth ? { orderId: created.json.id, authId: auth.id } : undefined;
}

async function captureRun(runId: string) {
  const ids = await createApproveAuthorize(runId, "A");
  if (!ids) return;
  const captureKey = `spike-${runId}-A-capture-v1`;
  const path = `/v2/payments/authorizations/${ids.authId}/capture`;

  console.log("\n== Order A: capture with final_capture true");
  type Capture = { id?: string; status?: string };
  const first = await paypalFetch<Capture>(path, {
    method: "POST",
    requestId: captureKey,
    body: { final_capture: true },
  });
  check(
    "A: captured",
    first.ok && first.json.status === "COMPLETED",
    `${first.json.id ?? "-"} ${first.json.status ?? ""}, ${describe(first)}`,
  );

  console.log("\n== Order A: duplicate capture with the SAME PayPal-Request-Id");
  const replay = await paypalFetch<Capture>(path, {
    method: "POST",
    requestId: captureKey,
    body: { final_capture: true },
  });
  check(
    "A: same request id replays the first capture",
    replay.ok && replay.json.id === first.json.id,
    `${replay.json.id ?? "-"}, ${describe(replay)}`,
  );

  console.log("\n== Order A: second capture with a NEW request id (must be refused)");
  const second = await paypalFetch<Capture>(path, {
    method: "POST",
    requestId: `spike-${runId}-A-capture-v2`,
    body: { final_capture: true },
  });
  check("A: second capture refused", !second.ok, describe(second));

  const order = await paypalFetch<AuthorizedOrder>(`/v2/checkout/orders/${ids.orderId}`);
  const captures = order.json.purchase_units?.[0]?.payments?.captures ?? [];
  check("A: exactly one capture on the order", captures.length === 1, `${captures.length} found`);
}

async function voidRun(runId: string) {
  const ids = await createApproveAuthorize(runId, "B");
  if (!ids) return;

  console.log("\n== Order B: void");
  const voided = await paypalFetch<{ status?: string }>(
    `/v2/payments/authorizations/${ids.authId}/void`,
    { method: "POST", requestId: `spike-${runId}-B-void-v1` },
  );
  // Void returns 204 by default, or the authorization with return=representation.
  check("B: void accepted", voided.ok, describe(voided));

  const auth = await paypalFetch<{ status?: string }>(`/v2/payments/authorizations/${ids.authId}`);
  check("B: authorisation status VOIDED", auth.json.status === "VOIDED", auth.json.status ?? "-");

  const capture = await paypalFetch(`/v2/payments/authorizations/${ids.authId}/capture`, {
    method: "POST",
    requestId: `spike-${runId}-B-capture-v1`,
    body: { final_capture: true },
  });
  check("B: capture after void refused", !capture.ok, describe(capture));
}

async function main() {
  const env = serverEnv();
  if (!env.SANDBOX_SELLER_A_EMAIL) throw new Error("SANDBOX_SELLER_A_EMAIL is not set");
  const runId = randomUUID();
  console.log(`SafeDeal payment spike, run ${runId}`);
  console.log(`API base ${env.PAYPAL_API_BASE}, payee: ${payeeLabel}`);

  await captureRun(runId);
  await voidRun(runId);

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n== Result: ${checks.length - failed.length}/${checks.length} checks passed`);
  for (const c of failed) console.log(`  FAILED: ${c.name}`);
  console.log(failed.length === 0 ? "GO" : "NO-GO (or incomplete): see failures above");
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "Unknown error");
    process.exitCode = 1;
  })
  .finally(() => rl.close());
