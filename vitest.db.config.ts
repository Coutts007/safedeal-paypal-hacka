import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Database tests (`*.db.test.ts`) against a real Postgres; run with `npm run test:db`.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.db.test.ts"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    globalSetup: ["./tests/db-setup.ts"],
    fileParallelism: false,
    env: {
      // Routes use getDb(), so point it at the test database too.
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://safedeal:safedeal@localhost:5433/safedeal_test",
      CRON_SECRET: "test-cron-secret",
      APP_BASE_URL: "http://localhost:3000",
      PAYPAL_CLIENT_ID: "test-id",
      PAYPAL_CLIENT_SECRET: "test-secret",
    },
  },
});
