import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ConnectorDatabase,
  openConnectorDatabase,
} from "./database.js";
import {
  applyMigrations,
  loadMigrations,
  migrations,
} from "./migrations.js";

const databases: ConnectorDatabase[] = [];
const directories: string[] = [];

const createDatabase = async (): Promise<ConnectorDatabase> => {
  const directory = await mkdtemp(join(tmpdir(), "pih-connectors-migrations-"));
  directories.push(directory);
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  databases.push(database);
  await database.read(() => undefined);
  return database;
};

const tableExists = (
  database: ConnectorDatabase,
  tableName: string,
): Promise<boolean> =>
  database.read(
    (handle) =>
      handle
        .prepare(
          "SELECT 1 AS found FROM sqlite_master " +
            "WHERE type = :type AND name = :name",
        )
        .get<{ found: number }>({ type: "table", name: tableName }) !== undefined,
  );

const migrationNames = (
  database: ConnectorDatabase,
): Promise<readonly string[]> =>
  database.read((handle) =>
    handle
      .prepare("SELECT name FROM connector_migrations ORDER BY name")
      .all<{ name: string }>()
      .map(({ name }) => name),
  );

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("connector migrations", () => {
  it("loads SQL files in lexical order with lowercase SHA-256 checksums", () => {
    const loaded = loadMigrations();

    expect(loaded.map(({ name }) => name)).toEqual(["0000_foundation"]);
    expect(loaded[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("applies later migrations in lexical order regardless of input order", async () => {
    const database = await createDatabase();
    const future = migrations({
      "0200_second":
        "INSERT INTO migration_order(position, name) VALUES(2, 'second');",
      "0100_first":
        "CREATE TABLE migration_order(position INTEGER PRIMARY KEY, name TEXT NOT NULL);" +
        "INSERT INTO migration_order(position, name) VALUES(1, 'first');",
    });

    await applyMigrations(database, [...loadMigrations(), ...future]);

    expect(
      await database.read((handle) =>
        handle
          .prepare("SELECT name FROM migration_order ORDER BY position")
          .all<{ name: string }>()
          .map(({ name }) => name),
      ),
    ).toEqual(["first", "second"]);
    expect(await migrationNames(database)).toEqual([
      "0000_foundation",
      "0100_first",
      "0200_second",
    ]);
  });

  it("refuses checksum drift before applying a later migration", async () => {
    const database = await createDatabase();
    const foundationSql = await readFile(
      new URL("../migrations/0000_foundation.sql", import.meta.url),
      "utf8",
    );

    await expect(
      applyMigrations(
        database,
        migrations({
          "0000_foundation": foundationSql + "\n-- changed",
          "0100_future": "CREATE TABLE future(id TEXT PRIMARY KEY);",
        }),
      ),
    ).rejects.toMatchObject({ code: "migration_checksum_mismatch" });
    expect(await tableExists(database, "future")).toBe(false);
  });

  it("fails when a recorded migration file is missing", async () => {
    const database = await createDatabase();

    await expect(applyMigrations(database, migrations({}))).rejects.toMatchObject(
      { code: "migration_missing" },
    );
  });

  it("commits each migration and record atomically", async () => {
    const database = await createDatabase();

    await expect(
      applyMigrations(database, [
        ...loadMigrations(),
        ...migrations({
          "0100_committed":
            "CREATE TABLE committed_first(id TEXT PRIMARY KEY);",
          "0200_broken":
            "CREATE TABLE must_rollback(id TEXT PRIMARY KEY);" +
            "INSERT INTO absent_table(id) VALUES('failure');",
        }),
      ]),
    ).rejects.toThrow();

    expect(await tableExists(database, "committed_first")).toBe(true);
    expect(await tableExists(database, "must_rollback")).toBe(false);
    expect(await migrationNames(database)).toEqual([
      "0000_foundation",
      "0100_committed",
    ]);
  });

  it("serializes concurrent migration runners without applying a stale plan", async () => {
    const database = await createDatabase();
    const future = migrations({
      "0100_concurrent":
        "CREATE TABLE concurrent_migration(id TEXT PRIMARY KEY);",
    });

    await expect(
      Promise.all([
        applyMigrations(database, [...loadMigrations(), ...future]),
        applyMigrations(database, [...loadMigrations(), ...future]),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(await migrationNames(database)).toEqual([
      "0000_foundation",
      "0100_concurrent",
    ]);
  });

  it("does not expose mutable migration definitions", () => {
    const loaded = loadMigrations();
    const generated = migrations({
      "0100_future": "CREATE TABLE future(id TEXT PRIMARY KEY);",
    });

    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded[0])).toBe(true);
    expect(Object.isFrozen(generated)).toBe(true);
    expect(Object.isFrozen(generated[0])).toBe(true);
  });
});
