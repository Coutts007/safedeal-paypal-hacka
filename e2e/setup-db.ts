// Before the Playwright server starts: create and migrate the e2e database, then empty it.
import { E2E_ENV } from "./env";

process.env.TEST_DATABASE_URL = E2E_ENV.DATABASE_URL;

async function main() {
  const { default: migrate } = await import("../tests/db-setup");
  const { resetDb, testDb } = await import("../tests/db");
  await migrate();
  const { db, close } = testDb();
  await resetDb(db);
  await close();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
