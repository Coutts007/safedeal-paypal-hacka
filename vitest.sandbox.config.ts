import "dotenv/config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests against the PayPal sandbox (`*.sandbox.test.ts`), using the real `.env`.
// Run by hand with `npm run test:sandbox`; not part of CI.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.sandbox.test.ts"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    testTimeout: 60_000,
  },
});
