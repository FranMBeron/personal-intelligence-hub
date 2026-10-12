import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConnectorDatabase, SqliteHandle } from "./database.js";

export type Migration = Readonly<{
  name: string;
  sql: string;
  sha256: string;
}>;

export type MigrationFailureCode =
  | "migration_checksum_mismatch"
  | "migration_missing";

export class MigrationError extends Error {
  readonly code: MigrationFailureCode;
  readonly migrationName: string;

  constructor(code: MigrationFailureCode, migrationName: string) {
    super(code + ": " + migrationName);
    this.name = "MigrationError";
    this.code = code;
    this.migrationName = migrationName;
  }
}

const checksum = (sql: string): string =>
  createHash("sha256").update(sql, "utf8").digest("hex");

const lexicalCompare = (left: Migration, right: Migration): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

const freezeMigrations = (
  values: readonly Readonly<{ name: string; sql: string }>[],
): readonly Migration[] => {
  const names = new Set<string>();
  const result = values
    .map(({ name, sql }) => {
      if (!/^[0-9][A-Za-z0-9_-]*$/u.test(name)) {
        throw new Error("Invalid migration name: " + name);
      }
      if (names.has(name)) throw new Error("Duplicate migration: " + name);
      names.add(name);
      return Object.freeze({ name, sql, sha256: checksum(sql) });
    })
    .sort(lexicalCompare);
  return Object.freeze(result);
};

export const migrations = (
  sqlByName: Readonly<Record<string, string>>,
): readonly Migration[] =>
  freezeMigrations(
    Object.entries(sqlByName).map(([name, sql]) => ({ name, sql })),
  );

export const loadMigrations = (
  directory: URL = new URL("../migrations/", import.meta.url),
): readonly Migration[] => {
  const directoryPath = fileURLToPath(directory);
  const loaded = readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".sql")
    .map((entry) => ({
      name: entry.name.slice(0, -".sql".length),
      sql: readFileSync(new URL(entry.name, directory), "utf8"),
    }));
  return freezeMigrations(loaded);
};

const trackingTableExists = (handle: SqliteHandle): boolean =>
  handle
    .prepare(
      "SELECT 1 AS found FROM sqlite_master " +
        "WHERE type = :type AND name = :name",
    )
    .get<{ found: number }>({
      type: "table",
      name: "connector_migrations",
    }) !== undefined;

const recordedMigrations = (
  handle: SqliteHandle,
): readonly Readonly<{ name: string; sha256: string }>[] => {
  if (!trackingTableExists(handle)) return Object.freeze([]);
  return handle
    .prepare(
      "SELECT name, sha256 FROM connector_migrations ORDER BY name",
    )
    .all<{ name: string; sha256: string }>();
};

export const pendingMigrations = (
  handle: SqliteHandle,
  available: readonly Migration[],
): readonly Migration[] => {
  const ordered = freezeMigrations(
    available.map(({ name, sql }) => ({ name, sql })),
  );
  const byName = new Map(
    ordered.map((migration) => [migration.name, migration]),
  );
  const recorded = recordedMigrations(handle);

  for (const existing of recorded) {
    const migration = byName.get(existing.name);
    if (migration === undefined) {
      throw new MigrationError("migration_missing", existing.name);
    }
    if (migration.sha256 !== existing.sha256) {
      throw new MigrationError(
        "migration_checksum_mismatch",
        existing.name,
      );
    }
  }

  const applied = new Set(recorded.map(({ name }) => name));
  return Object.freeze(
    ordered.filter((migration) => !applied.has(migration.name)),
  );
};

export const applyMigrationToHandle = (
  handle: SqliteHandle,
  migration: Migration,
): void => {
  handle.exec(migration.sql);
  if (!trackingTableExists(handle)) {
    throw new Error(
      "Migration " + migration.name + " did not create connector_migrations",
    );
  }
  handle
    .prepare(
      "INSERT INTO connector_migrations(name, sha256, applied_at) " +
        "VALUES(:name,:sha256,:appliedAt)",
    )
    .run({
      name: migration.name,
      sha256: migration.sha256,
      appliedAt: new Date().toISOString(),
    });
};

const migrationQueues = new WeakMap<ConnectorDatabase, Promise<void>>();

export const applyMigrations = (
  database: ConnectorDatabase,
  available: readonly Migration[],
): Promise<void> => {
  const previous = migrationQueues.get(database) ?? Promise.resolve();
  const result = previous.then(async () => {
    const pending = await database.transaction((handle) =>
      pendingMigrations(handle, available),
    );
    for (const migration of pending) {
      await database.transaction((handle) => {
        applyMigrationToHandle(handle, migration);
      });
    }
  });
  migrationQueues.set(
    database,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
};
