import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { serverEnv } from "@/lib/env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle; has the same query API as `Db`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

let pool: Pool | undefined;
let db: Db | undefined;

export function getDb(): Db {
  if (!db) {
    pool = new Pool({ connectionString: serverEnv().DATABASE_URL, max: 10 });
    db = drizzle(pool, { schema });
  }
  return db;
}

/** For scripts and tests: a database handle on an explicit URL. */
export function connect(url: string): { db: Db; close: () => Promise<void> } {
  const p = new Pool({ connectionString: url, max: 10 });
  return { db: drizzle(p, { schema }), close: () => p.end() };
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
