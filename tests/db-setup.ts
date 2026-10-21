// Vitest global setup for database tests: create the test database if needed and migrate it.
// Uses TEST_DATABASE_URL (default: the local Docker Postgres on port 5433, database safedeal_test),
// never DATABASE_URL, so tests cannot wipe development data.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { TEST_DATABASE_URL } from "./db";

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  const admin = new Client({
    connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).toString(),
  });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
  await admin.end();

  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  await client.end();
}
