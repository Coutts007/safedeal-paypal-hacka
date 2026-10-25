// Environment of the server the Playwright tests run against: its own database, the fake PayPal
// on port 4010, no LLM key, and throwaway test secrets (not real ones; never reused elsewhere).
// One day lasts 10 seconds, so the 48 h ship-by window passes in 20 s.

export const E2E_PORT = 3100;
export const FAKE_PAYPAL = "http://localhost:4010";
export const SDK_URL = "https://paypal-sdk.e2e.invalid/web-sdk/v6/core";
export const DEMO_TIME_SCALE = 8640;

export const E2E_ENV = {
  NEXT_DIST_DIR: ".next-e2e",
  PORT: String(E2E_PORT),
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ?? "postgres://safedeal:safedeal@localhost:5433/safedeal_e2e",
  PAYPAL_API_BASE: FAKE_PAYPAL,
  PAYPAL_CONNECT_URL: `${FAKE_PAYPAL}/connect`,
  PAYPAL_CLIENT_ID: "e2e-client-id",
  PAYPAL_CLIENT_SECRET: "e2e-client-secret",
  PAYPAL_WEBHOOK_ID: "e2e-webhook-id",
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: "e2e-client-id",
  NEXT_PUBLIC_PAYPAL_SDK_URL: SDK_URL,
  LLM_API_KEY: "",
  COURIER_MODE: "test",
  TEST_COURIER_SECRET: "e2e-courier-secret",
  CRON_SECRET: "e2e-cron-secret",
  ADMIN_PASSWORD: "e2e-admin-password",
  HANDOVER_SECRET: "e2e-handover-secret-0123456789abcdef",
  APP_BASE_URL: `http://localhost:${E2E_PORT}`,
  DEMO_TIME_SCALE: String(DEMO_TIME_SCALE),
  DEMO_MODE: "false",
  MAX_DEAL_USD: "500",
  SANDBOX_SELLER_A_EMAIL: "seller-a@business.example.com",
} as const;
