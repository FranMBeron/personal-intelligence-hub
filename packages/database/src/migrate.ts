import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

const migrationName = "0000_initial.sql";
const migrationUrl = new URL(`../../migrations/${migrationName}`, import.meta.url);

export const runMigrations = async (connectionString: string): Promise<void> => {
  const source = await readFile(migrationUrl, "utf8");
  const checksum = createHash("sha256").update(source).digest("hex");
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('personal-intelligence-hub:migrations'))",
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS pih_schema_migrations (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const applied = await client.query<{ checksum: string }>(
      "SELECT checksum FROM pih_schema_migrations WHERE name = $1",
      [migrationName],
    );
    const recordedChecksum = applied.rows[0]?.checksum;
    if (recordedChecksum === undefined) {
      await client.query(source);
      await client.query(
        "INSERT INTO pih_schema_migrations (name, checksum) VALUES ($1, $2)",
        [migrationName, checksum],
      );
    } else if (recordedChecksum !== checksum) {
      throw new Error(`Applied migration ${migrationName} has a different checksum.`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

const main = async (): Promise<void> => {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }
  await runMigrations(connectionString);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Database migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
