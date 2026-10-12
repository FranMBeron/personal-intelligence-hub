import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

export type DatabaseClient = Readonly<{
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
}>;

export const createDatabaseClient = (config: PoolConfig): DatabaseClient => {
  const pool = new Pool(config);

  return {
    db: drizzle(pool, { schema }),
    pool,
    close: async () => pool.end(),
  };
};
