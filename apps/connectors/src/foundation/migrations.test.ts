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

const packagedNames = (): string[] => loadMigrations().map(({ name }) => name);

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
  it("keeps packaged migration SQL additive for rollback compatibility", () => {
    const destructiveSql = /\b(?:DROP\s+(?:TABLE|COLUMN|INDEX|TRIGGER|VIEW)|RENAME\s+(?:TABLE|COLUMN)|ALTER\s+TABLE\b[\s\S]{0,240}\b(?:DROP|RENAME)\b|VACUUM)\b/iu;
    const violations = loadMigrations()
      .filter(({ sql }) => destructiveSql.test(sql))
      .map(({ name }) => name);
    expect(violations).toEqual([]);
  });

  it("loads SQL files in lexical order with lowercase SHA-256 checksums", () => {
    // Pinned packaged set: each provider branch appends its migrations here.
    const loaded = loadMigrations(new URL("../migrations/", import.meta.url));

    expect(loaded.map(({ name }) => name)).toEqual(["0000_foundation"]);
    expect(loaded[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("applies later migrations in lexical order regardless of input order", async () => {
    const database = await createDatabase();
    const future = migrations({
      "9200_second":
        "INSERT INTO migration_order(position, name) VALUES(2, 'second');",
      "9100_first":
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
      ...packagedNames(),
      "9100_first",
      "9200_second",
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
          "9100_future": "CREATE TABLE future(id TEXT PRIMARY KEY);",
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
          "9100_committed":
            "CREATE TABLE committed_first(id TEXT PRIMARY KEY);",
          "9200_broken":
            "CREATE TABLE must_rollback(id TEXT PRIMARY KEY);" +
            "INSERT INTO absent_table(id) VALUES('failure');",
        }),
      ]),
    ).rejects.toThrow();

    expect(await tableExists(database, "committed_first")).toBe(true);
    expect(await tableExists(database, "must_rollback")).toBe(false);
    expect(await migrationNames(database)).toEqual([
      ...packagedNames(),
      "9100_committed",
    ]);
  });

  it("serializes concurrent migration runners without applying a stale plan", async () => {
    const database = await createDatabase();
    const future = migrations({
      "9100_concurrent":
        "CREATE TABLE concurrent_migration(id TEXT PRIMARY KEY);",
    });

    await expect(
      Promise.all([
        applyMigrations(database, [...loadMigrations(), ...future]),
        applyMigrations(database, [...loadMigrations(), ...future]),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(await migrationNames(database)).toEqual([
      ...packagedNames(),
      "9100_concurrent",
    ]);
  });

  it("lets an older runtime reopen an additive newer schema and preserves the full migration prefix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pih-connectors-cross-version-"));
    directories.push(directory);
    const path = join(directory, "connectors.sqlite");
    const v1 = loadMigrations();
    const v2 = [
      ...v1,
      ...migrations({
        "9001_additive_notes": "CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT NOT NULL);",
        "9002_additive_tags": "CREATE TABLE tags(id TEXT PRIMARY KEY, label TEXT NOT NULL);",
      }),
    ];
    const first = openConnectorDatabase(path, v1);
    databases.push(first);
    await first.read(() => undefined);
    await applyMigrations(first, v2);
    await first.write((handle) => handle.prepare("INSERT INTO notes VALUES(:id,:body)").run({ id: "note-1", body: "kept" }));
    await first.close();

    const olderRuntime = openConnectorDatabase(path, v1);
    databases.push(olderRuntime);
    await expect(olderRuntime.read((handle) =>
      handle.prepare("SELECT body FROM notes WHERE id = :id").get({ id: "note-1" }),
    )).resolves.toEqual({ body: "kept" });
    await olderRuntime.close();

    const newerRuntime = openConnectorDatabase(path, v2);
    databases.push(newerRuntime);
    await expect(newerRuntime.read((handle) =>
      handle.prepare("SELECT name FROM connector_migrations ORDER BY name").all<{name:string}>().map(({name})=>name),
    )).resolves.toEqual([...packagedNames(), "9001_additive_notes", "9002_additive_tags"]);
  });

  it("rejects an altered future checksum when the migration record and compatibility ledger disagree", async () => {
    const database = await createDatabase();
    const future = migrations({
      "9001_additive_notes": "CREATE TABLE notes(id TEXT PRIMARY KEY);",
    });
    await applyMigrations(database, [...loadMigrations(), ...future]);
    const databasePath = join(directories.at(-1)!, "connectors.sqlite");
    await database.write((handle) => {
      handle.prepare("UPDATE connector_migrations SET sha256 = :sha WHERE name = :name")
        .run({ name: "9001_additive_notes", sha: "f".repeat(64) });
    });
    await database.close();
    const reopened = openConnectorDatabase(databasePath, loadMigrations());
    databases.push(reopened);
    await expect(reopened.read(() => undefined)).rejects.toMatchObject({ code: "migration_history_invalid" });
  });

  it("rejects a missing applied-history sequence entry before accepting a future suffix", async () => {
    const database = await createDatabase();
    await applyMigrations(database, [
      ...loadMigrations(),
      ...migrations({
        "9001_additive_notes": "CREATE TABLE notes(id TEXT PRIMARY KEY);",
      }),
    ]);
    await database.write((handle) => {
      handle.prepare("DELETE FROM connector_migration_history WHERE sequence = :sequence")
        .run({ sequence: 1 });
    });
    const databasePath = join(directories.at(-1)!, "connectors.sqlite");
    await database.close();

    const reopened = openConnectorDatabase(databasePath, loadMigrations());
    databases.push(reopened);
    await expect(reopened.read(() => undefined))
      .rejects.toMatchObject({ code: "migration_history_invalid" });
  });

  it("rejects an unknown migration inserted before the packaged prefix", async () => {
    const database = await createDatabase();
    await database.write((handle) => {
      handle.prepare("INSERT INTO connector_migrations(name,sha256,applied_at) VALUES(:name,:sha,:time)")
        .run({ name: "0000_injected", sha: "a".repeat(64), time: "seeded" });
    });
    const databasePath = join(directories.at(-1)!, "connectors.sqlite");
    await database.close();

    const reopened = openConnectorDatabase(databasePath, loadMigrations());
    databases.push(reopened);
    await expect(reopened.read(() => undefined))
      .rejects.toMatchObject({ code: "migration_history_invalid" });
  });

  it("rejects an unsupported migration history compatibility format", async () => {
    const database = await createDatabase();
    const path = join(directories.at(-1)!, "connectors.sqlite");
    await database.write((handle) => {
      handle.prepare("UPDATE connector_migration_history_metadata SET format_version = :version")
        .run({ version: 99 });
    });
    await database.close();

    const reopened = openConnectorDatabase(path, loadMigrations());
    databases.push(reopened);
    await expect(reopened.read(() => undefined))
      .rejects.toMatchObject({ code: "migration_history_invalid" });
  });

  it("does not expose mutable migration definitions", () => {
    const loaded = loadMigrations();
    const generated = migrations({
      "9100_future": "CREATE TABLE future(id TEXT PRIMARY KEY);",
    });

    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded[0])).toBe(true);
    expect(Object.isFrozen(generated)).toBe(true);
    expect(Object.isFrozen(generated[0])).toBe(true);
  });
});
