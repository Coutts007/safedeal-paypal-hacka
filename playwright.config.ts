import { defineConfig, devices } from "@playwright/test";
import { E2E_ENV, E2E_PORT, FAKE_PAYPAL } from "./e2e/env";

// End-to-end tests against a production build on port 3100 with its own database and a fake
// PayPal (e2e/fake-paypal.mjs); the PayPal SDK is replaced in the browser by e2e/paypal-sdk-stub.js.
// No sandbox account, no LLM key and no .env secret is used. Needs the Docker Postgres (npm run db:up).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "mobile-360", use: { ...devices["Pixel 5"], viewport: { width: 360, height: 780 } } },
  ],
  webServer: [
    {
      command: "node e2e/fake-paypal.mjs",
      url: `${FAKE_PAYPAL}/__calls`,
      reuseExistingServer: false,
    },
    {
      command: "npx tsx e2e/setup-db.ts && npx next build && npx next start",
      url: `http://localhost:${E2E_PORT}/api/health`,
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
