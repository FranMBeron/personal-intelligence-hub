import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ConnectorDatabase,
  openConnectorDatabase,
  type SqlValue,
  type SqliteHandle,
} from "./database.js";

const databases: ConnectorDatabase[] = [];
const directories: string[] = [];

const createDatabase = async (): Promise<{
  database: ConnectorDatabase;
  databasePath: string;
  directory: string;
}> => {
  const directory = await mkdtemp(join(tmpdir(), "pih-connectors-database-"));
  directories.push(directory);
  const databasePath = join(directory, "connectors.sqlite");
  const database = openConnectorDatabase(databasePath);
  databases.push(database);
  await database.read(() => undefined);
  return { database, databasePath, directory };
};

const pragma = async (
  database: ConnectorDatabase,
  name: string,
): Promise<SqlValue | undefined> =>
  database.read((handle) => {
    const row = handle.prepare("PRAGMA " + name).get<Record<string, SqlValue>>();
    return row === undefined ? undefined : Object.values(row)[0];
  });

const insertPreference = (
  database: ConnectorDatabase,
  actorId: string,
): Promise<unknown> =>
  database.write((handle) =>
    handle
      .prepare(
        "INSERT INTO user_preferences" +
          "(actor_id,time_zone,version,created_at,updated_at) " +
          "VALUES(:actorId,:timeZone,1,:now,:now)",
      )
      .run({
        actorId,
        timeZone: "UTC",
        now: "2026-10-12T12:00:00.000Z",
      }),
  );

const countPreferences = (database: ConnectorDatabase): Promise<number> =>
  database.read(
    (handle) =>
      handle
        .prepare("SELECT count(*) AS count FROM user_preferences")
        .get<{ count: number }>()?.count ?? -1,
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

describe("connector database", () => {
  it("enables hardened pragmas, restrictive permissions, and foundation migration", async () => {
    const { database, databasePath } = await createDatabase();

    expect(await pragma(database, "journal_mode")).toBe("wal");
    expect(await pragma(database, "foreign_keys")).toBe(1);
    expect(await pragma(database, "busy_timeout")).toBe(5_000);
    expect(await pragma(database, "synchronous")).toBe(1);
    expect(
      await database.read((handle) =>
        handle
          .prepare("SELECT name FROM connector_migrations ORDER BY name")
          .all<{ name: string }>()
          .map(({ name }) => name),
      ),
    ).toEqual(["0000_foundation"]);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
  });

  it("rolls back every transaction write when the callback throws", async () => {
    const { database } = await createDatabase();

    await expect(
      database.transaction((handle) => {
        handle
          .prepare(
            "INSERT INTO user_preferences" +
              "(actor_id,time_zone,version,created_at,updated_at) " +
              "VALUES(:actorId,:timeZone,1,:now,:now)",
          )
          .run({
            actorId: "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10",
            timeZone: "UTC",
            now: "2026-10-12T12:00:00.000Z",
          });
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(await countPreferences(database)).toBe(0);
  });

  it("returns copied immutable results and accepts named parameters only", async () => {
    const { database } = await createDatabase();
    const result = await insertPreference(
      database,
      "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10",
    );
    expect(result).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(Object.isFrozen(result)).toBe(true);

    const { row, rows } = await database.read((handle) => {
      const statement = handle.prepare(
        "SELECT actor_id AS actorId, time_zone AS timeZone " +
          "FROM user_preferences WHERE actor_id = :actorId",
      );
      const parameters = {
        actorId: "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10",
      };
      return {
        row: statement.get<{ actorId: string; timeZone: string }>(parameters),
        rows: statement.all<{ actorId: string; timeZone: string }>(parameters),
      };
    });
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);

    await expect(
      database.read((handle) => {
        const get = handle.prepare("SELECT :value AS value").get as unknown as (
          parameters: unknown,
        ) => unknown;
        return get(["positional-parameters-are-forbidden"]);
      }),
    ).rejects.toThrow(/named parameter object/u);
  });

  it("never exposes native database or statement handles", async () => {
    const { database } = await createDatabase();

    expect(Object.keys(database)).toEqual([]);
    await database.read((handle) => {
      expect(Object.keys(handle).sort()).toEqual(["exec", "prepare"]);
      expect("close" in handle).toBe(false);
      expect("location" in handle).toBe(false);
      const statement = handle.prepare("SELECT 1 AS value");
      expect(Object.keys(statement).sort()).toEqual(["all", "get", "run"]);
      expect("sourceSQL" in statement).toBe(false);
    });
  });

  it("serializes writes while allowing a read between queued writes", async () => {
    const { database } = await createDatabase();
    const order: string[] = [];

    const first = database.write(() => {
      order.push("write-one");
    });
    const second = database.write(() => {
      order.push("write-two");
    });
    const read = database.read(() => {
      order.push("read");
    });

    await Promise.all([first, second, read]);
    expect(order).toEqual(["write-one", "read", "write-two"]);
  });

  it("does not roll back after commit when sidecar hardening fails", async () => {
    const { database, databasePath } = await createDatabase();
    await insertPreference(database, "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10");
    const walPath = databasePath + "-wal";
    await chmod(walPath, 0o000);

    try {
      await expect(
        database.transaction((handle) =>
          handle
            .prepare(
              "INSERT INTO user_preferences" +
                "(actor_id,time_zone,version,created_at,updated_at) " +
                "VALUES(:actorId,:timeZone,1,:now,:now)",
            )
            .run({
              actorId: "018f5f17-5d0a-7c76-aac3-4f0f6ce44f11",
              timeZone: "UTC",
              now: "2026-10-12T12:00:00.000Z",
            }),
        ),
      ).rejects.toThrow(/permission denied|EACCES/u);
      expect(await countPreferences(database)).toBe(2);
    } finally {
      await chmod(walPath, 0o600);
    }
  });

  it("handles rejected async callback results without unhandled rejections", async () => {
    const { database } = await createDatabase();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const callback = (async () => {
        throw new Error("late callback failure");
      }) as unknown as (handle: SqliteHandle) => undefined;
      await expect(database.read(callback)).rejects.toThrow(/synchronous/u);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("drains a read accepted before close", async () => {
    const { database } = await createDatabase();
    const read = database.read((handle) =>
      handle.prepare("SELECT 1 AS value").get<{ value: number }>(),
    );
    const closing = database.close();

    await expect(read).resolves.toEqual({ value: 1 });
    await expect(closing).resolves.toBeUndefined();
  });

  it("rejects nested writes and transactions before they can deadlock", async () => {
    const { database } = await createDatabase();
    let nestedWrite: Promise<unknown> | undefined;
    let nestedTransaction: Promise<unknown> | undefined;

    await database.write(() => {
      nestedTransaction = database.transaction(() => undefined);
    });
    await expect(nestedTransaction).rejects.toThrow(/nested/u);
    await database.transaction(() => {
      nestedWrite = database.write(() => undefined);
    });
    await expect(nestedWrite).rejects.toThrow(/nested/u);
  });

  it("rejects every queued operation when startup migrations fail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pih-connectors-startup-failure-"));
    directories.push(directory);
    const databasePath = join(directory, "connectors.sqlite");
    const seed = new DatabaseSync(databasePath);
    seed.exec(
      "CREATE TABLE connector_migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL);" +
        "INSERT INTO connector_migrations VALUES('0000_foundation','broken','seeded');",
    );
    seed.close();

    const database = openConnectorDatabase(databasePath);
    databases.push(database);
    const write = database.write((handle) =>
      handle.exec("CREATE TABLE should_not_exist(id INTEGER PRIMARY KEY)"),
    );
    const transaction = database.transaction((handle) =>
      handle.exec("CREATE TABLE should_also_not_exist(id INTEGER PRIMARY KEY)"),
    );
    const backup = database.backupTo(join(directory, "backup.sqlite"));

    await expect(database.read(() => undefined)).rejects.toMatchObject({
      code: "migration_checksum_mismatch",
    });
    await expect(write).rejects.toMatchObject({
      code: "migration_checksum_mismatch",
    });
    await expect(transaction).rejects.toMatchObject({
      code: "migration_checksum_mismatch",
    });
    await expect(backup).rejects.toMatchObject({
      code: "migration_checksum_mismatch",
    });
    await expect(database.close()).resolves.toBeUndefined();
    expect(await stat(databasePath)).toBeDefined();
  });

  it("rejects directories and symlinks without changing their targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pih-connectors-unsafe-path-"));
    directories.push(directory);
    const unrelatedPath = join(directory, "unrelated.txt");
    const symlinkPath = join(directory, "database-link.sqlite");
    const directoryPath = join(directory, "database-directory");
    await writeFile(unrelatedPath, "keep permissions");
    await chmod(unrelatedPath, 0o644);
    await symlink(unrelatedPath, symlinkPath);
    await mkdir(directoryPath, { mode: 0o755 });

    expect(() => openConnectorDatabase(symlinkPath)).toThrow(/regular file|symbolic link/u);
    expect(() => openConnectorDatabase(directoryPath)).toThrow(/regular file|directory/u);
    expect((await stat(unrelatedPath)).mode & 0o777).toBe(0o644);
    expect((await stat(directoryPath)).mode & 0o777).toBe(0o755);
  });

  it("revokes public handles and blocks writes from read callbacks", async () => {
    const { database } = await createDatabase();
    let retainedHandle: SqliteHandle | undefined;
    let retainedStatement:
      | ReturnType<SqliteHandle["prepare"]>
      | undefined;

    await database.read((handle) => {
      retainedHandle = handle;
      retainedStatement = handle.prepare("SELECT 1 AS value");
      expect(() => handle.exec("PRAGMA query_only=OFF")).toThrow(/read-only/u);
      expect(() =>
        handle
          .prepare(
            "INSERT INTO user_preferences" +
              "(actor_id,time_zone,version,created_at,updated_at) " +
              "VALUES(:actorId,:timeZone,1,:now,:now)",
          )
          .run({
            actorId: "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10",
            timeZone: "UTC",
            now: "2026-10-12T12:00:00.000Z",
          }),
      ).toThrow(/read-only/u);
    });

    expect(() => retainedHandle?.prepare("SELECT 1")).toThrow(/expired/u);
    expect(() => retainedStatement?.get()).toThrow(/expired/u);
    expect(await countPreferences(database)).toBe(0);

    await database.close();
    await expect(database.read(() => undefined)).rejects.toThrow(/closed/u);
  });

  it("creates a serialized online backup at a new absolute path", async () => {
    const { database, directory } = await createDatabase();
    const destinationPath = join(directory, "backup.sqlite");
    const actorId = "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10";

    const write = insertPreference(database, actorId);
    const backup = database.backupTo(destinationPath);
    await Promise.all([write, backup]);

    const snapshot = new DatabaseSync(destinationPath, { readOnly: true });
    try {
      expect(
        snapshot
          .prepare("SELECT actor_id AS actorId FROM user_preferences")
          .get(),
      ).toEqual({ actorId });
    } finally {
      snapshot.close();
    }
    expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
    await expect(database.backupTo(destinationPath)).rejects.toThrow(
      /already exists/u,
    );
    await expect(database.backupTo("relative.sqlite")).rejects.toThrow(
      /absolute/u,
    );
  });

  it("queues close after accepted writes and rejects later operations", async () => {
    const { database } = await createDatabase();
    const write = insertPreference(
      database,
      "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10",
    );

    const close = database.close();

    await expect(write).resolves.toMatchObject({ changes: 1 });
    await expect(database.read(() => undefined)).rejects.toThrow(/closed/u);
    await expect(database.write(() => undefined)).rejects.toThrow(/closed/u);
    await expect(database.transaction(() => undefined)).rejects.toThrow(
      /closed/u,
    );
    await expect(close).resolves.toBeUndefined();
  });

  it("tightens an existing database file's permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pih-connectors-mode-"));
    directories.push(directory);
    const databasePath = join(directory, "connectors.sqlite");
    await writeFile(databasePath, "");
    await chmod(databasePath, 0o666);

    const database = openConnectorDatabase(databasePath);
    databases.push(database);
    await database.read(() => undefined);

    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
  });
});
