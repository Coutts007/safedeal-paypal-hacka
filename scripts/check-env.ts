/**
 * Phase 0 setup check. Run with: npx tsx scripts/check-env.ts
 * Prints which variables are set (names only) and whether a PayPal sandbox
 * OAuth token can be obtained. Never prints any secret or token.
 */
import "dotenv/config";
import { parseServerEnv } from "../lib/env";

const expected = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "NEXT_PUBLIC_PAYPAL_CLIENT_ID",
  "DATABASE_URL",
  "LLM_API_KEY",
  "SANDBOX_SELLER_A_EMAIL",
  "SANDBOX_SELLER_B_EMAIL",
];

for (const name of expected) {
  console.log(`${process.env[name] ? "set    " : "MISSING"}  ${name}`);
}

async function main() {
  const env = parseServerEnv(process.env);
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString(
    "base64",
  );
  const res = await fetch(`${env.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (res.ok) {
    const json = (await res.json()) as { expires_in?: number };
    console.log(`PayPal sandbox OAuth: OK (token valid for ${json.expires_in ?? "?"} s)`);
  } else {
    const debugId = res.headers.get("paypal-debug-id") ?? "n/a";
    console.log(`PayPal sandbox OAuth: FAILED with HTTP ${res.status} (debug_id ${debugId})`);
    console.log("Check that the client ID and secret are the SANDBOX credentials of the same app.");
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : "Unknown error");
  process.exitCode = 1;
});
