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
      DATABASE_URL: "postgres://unused",
      PAYPAL_CLIENT_ID: "test-id",
      PAYPAL_CLIENT_SECRET: "test-secret",
    },
  },
});
