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
  | "migration_missing"
  | "migration_history_invalid";

export type MigrationRecord = Readonly<{ name: string; sha256: string }>;
export type MigrationHistoryEntry = Readonly<{
  sequence: number;
  name: string;
  sha256: string;
  previousSha256: string;
  entrySha256: string;
}>;
export type MigrationHistoryMetadata = Readonly<{
  singletonId: number;
  formatVersion: number;
  appliedCount: number;
  headSha256: string;
}>;


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

const HISTORY_FORMAT_VERSION = 1;
const HISTORY_GENESIS = checksum("pih-connectors-migration-history-v1");
const shaPattern = /^[a-f0-9]{64}$/u;
const hashEntry = (previousSha256: string, sequence: number, name: string, sha256: string): string =>
  checksum(JSON.stringify([HISTORY_FORMAT_VERSION, sequence, name, sha256, previousSha256]));

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

const tableExists = (handle: SqliteHandle, name: string): boolean =>
  handle
    .prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = :type AND name = :name",
    )
    .get<{ found: number }>({ type: "table", name }) !== undefined;

const recordedMigrations = (handle: SqliteHandle): readonly MigrationRecord[] => {
  if (!tableExists(handle, "connector_migrations")) return Object.freeze([]);
  return handle
    .prepare("SELECT name, sha256 FROM connector_migrations ORDER BY name")
    .all<MigrationRecord>();
};

export const readMigrationHistory = (handle: SqliteHandle): Readonly<{
  entries?: readonly MigrationHistoryEntry[];
  metadata?: MigrationHistoryMetadata;
}> => {
  const hasEntries = tableExists(handle, "connector_migration_history");
  const hasMetadata = tableExists(handle, "connector_migration_history_metadata");
  if (hasEntries !== hasMetadata) {
    throw new MigrationError("migration_history_invalid", "metadata");
  }
  if (!hasEntries) return Object.freeze({});
  const entries = handle
    .prepare(
      "SELECT sequence, name, sha256, previous_sha256 AS previousSha256, " +
        "entry_sha256 AS entrySha256 FROM connector_migration_history ORDER BY sequence",
    )
    .all<MigrationHistoryEntry>();
  const metadataRows = handle
    .prepare(
      "SELECT singleton_id AS singletonId, format_version AS formatVersion, " +
        "applied_count AS appliedCount, head_sha256 AS headSha256 " +
        "FROM connector_migration_history_metadata",
    )
    .all<MigrationHistoryMetadata>();
  if (metadataRows.length !== 1 || metadataRows[0] === undefined) {
    throw new MigrationError("migration_history_invalid", "metadata");
  }
  return Object.freeze({ entries, metadata: metadataRows[0] });
};

export const validateMigrationHistory = (
  recorded: readonly MigrationRecord[],
  state: Readonly<{ entries?: readonly MigrationHistoryEntry[]; metadata?: MigrationHistoryMetadata }>,
  available: readonly Migration[],
): readonly MigrationRecord[] => {
  const ordered = freezeMigrations(available.map(({ name, sql }) => ({ name, sql })));
  if (recorded.some((row) => !/^[0-9][A-Za-z0-9_-]*$/u.test(row.name))) {
    throw new MigrationError("migration_history_invalid", "records");
  }
  if (recorded.some((row, index) => index > 0 && recorded[index - 1]!.name >= row.name)) {
    throw new MigrationError("migration_history_invalid", "order");
  }
  for (let index = 0; index < Math.min(recorded.length, ordered.length); index += 1) {
    const actual = recorded[index]!;
    const expected = ordered[index]!;
    if (actual.name !== expected.name) {
      throw new MigrationError("migration_missing", expected.name);
    }
    if (actual.sha256 !== expected.sha256) {
      throw new MigrationError("migration_checksum_mismatch", expected.name);
    }
  }

  if (recorded.some((row) => !shaPattern.test(row.sha256))) {
    throw new MigrationError("migration_history_invalid", "checksums");
  }

  if (recorded.length > ordered.length && ordered.length === 0) {
    throw new MigrationError("migration_missing", recorded[0]!.name);
  }
  const hasMarker = state.entries !== undefined && state.metadata !== undefined;
  if ((state.entries === undefined) !== (state.metadata === undefined)) {
    throw new MigrationError("migration_history_invalid", "metadata");
  }
  if (!hasMarker) {
    if (recorded.length > ordered.length) {
      throw new MigrationError("migration_missing", recorded[ordered.length]!.name);
    }
    return recorded;
  }
  if (ordered.length > 0 && recorded.length > ordered.length && recorded.slice(ordered.length).some((row) =>
    row.name <= ordered.at(-1)!.name)) {
    throw new MigrationError("migration_history_invalid", "future_suffix");
  }

  const entries = state.entries!;
  const metadata = state.metadata!;
  if (
    metadata.singletonId !== 1 ||
    metadata.formatVersion !== HISTORY_FORMAT_VERSION ||
    metadata.appliedCount !== recorded.length ||
    entries.length !== recorded.length ||
    !shaPattern.test(metadata.headSha256)
  ) throw new MigrationError("migration_history_invalid", "metadata");

  let previous = HISTORY_GENESIS;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const record = recorded[index]!;
    const expectedEntryHash = hashEntry(previous, index, record.name, record.sha256);
    if (
      entry.sequence !== index ||
      entry.name !== record.name ||
      entry.sha256 !== record.sha256 ||
      entry.previousSha256 !== previous ||
      entry.entrySha256 !== expectedEntryHash ||
      !shaPattern.test(entry.sha256)
    ) throw new MigrationError("migration_history_invalid", record.name);
    previous = expectedEntryHash;
  }
  if (metadata.headSha256 !== previous) {
    throw new MigrationError("migration_history_invalid", "head");
  }
  return recorded;
};

const appendHistory = (handle: SqliteHandle, record: MigrationRecord): void => {
  const state = readMigrationHistory(handle);
  const metadata = state.metadata;
  if (metadata === undefined || state.entries === undefined || metadata.appliedCount !== state.entries.length) {
    throw new MigrationError("migration_history_invalid", "metadata");
  }
  const sequence = metadata.appliedCount;
  const entrySha256 = hashEntry(metadata.headSha256, sequence, record.name, record.sha256);
  handle.prepare(
    "INSERT INTO connector_migration_history(sequence,name,sha256,previous_sha256,entry_sha256) " +
      "VALUES(:sequence,:name,:sha256,:previousSha256,:entrySha256)",
  ).run({
    sequence,
    name: record.name,
    sha256: record.sha256,
    previousSha256: metadata.headSha256,
    entrySha256,
  });
  handle.prepare(
    "UPDATE connector_migration_history_metadata SET applied_count=:count, head_sha256=:head WHERE singleton_id=1",
  ).run({ count: sequence + 1, head: entrySha256 });
};

export const initializeMigrationHistory = (
  handle: SqliteHandle,
  available: readonly Migration[],
): void => {
  const records = recordedMigrations(handle);
  const state = readMigrationHistory(handle);
  validateMigrationHistory(records, state, available);
  if (state.metadata !== undefined) return;

  handle.exec(
    "CREATE TABLE connector_migration_history (" +
      "sequence INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, " +
      "sha256 TEXT NOT NULL, previous_sha256 TEXT NOT NULL, entry_sha256 TEXT NOT NULL); " +
    "CREATE TABLE connector_migration_history_metadata (" +
      "singleton_id INTEGER PRIMARY KEY NOT NULL, format_version INTEGER NOT NULL, " +
      "applied_count INTEGER NOT NULL, head_sha256 TEXT NOT NULL);",
  );
  handle.prepare(
    "INSERT INTO connector_migration_history_metadata(singleton_id,format_version,applied_count,head_sha256) " +
      "VALUES(1,:version,0,:head)",
  ).run({ version: HISTORY_FORMAT_VERSION, head: HISTORY_GENESIS });
  for (const record of records) appendHistory(handle, record);
};

export const pendingMigrations = (
  handle: SqliteHandle,
  available: readonly Migration[],
): readonly Migration[] => {
  const ordered = freezeMigrations(
    available.map(({ name, sql }) => ({ name, sql })),
  );
  const recorded = validateMigrationHistory(recordedMigrations(handle), readMigrationHistory(handle), ordered);
  const applied = new Set(recorded.map(({ name }) => name));
  return Object.freeze(ordered.filter((migration) => !applied.has(migration.name)));
};

export const applyMigrationToHandle = (
  handle: SqliteHandle,
  migration: Migration,
): void => {
  handle.exec(migration.sql);
  if (!tableExists(handle, "connector_migrations")) {
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
  appendHistory(handle, migration);
};

const migrationQueues = new WeakMap<ConnectorDatabase, Promise<void>>();

export const applyMigrations = (
  database: ConnectorDatabase,
  available: readonly Migration[],
): Promise<void> => {
  const previous = migrationQueues.get(database) ?? Promise.resolve();
  const result = previous.then(async () => {
    const pending = await database.transaction((handle) => {
      initializeMigrationHistory(handle, available);
      return pendingMigrations(handle, available);
    });
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
