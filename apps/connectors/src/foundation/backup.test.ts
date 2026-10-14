import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openConnectorDatabase, type ConnectorDatabase } from "./database.js";
import {
  createConnectorBackup,
  restoreConnectorBackup,
  verifyConnectorBackup,
} from "./backup.js";
import { loadMigrations } from "./migrations.js";

const databases: ConnectorDatabase[] = [];
const directories: string[] = [];
const fixedClock = (): Date => new Date("2026-10-12T12:34:56.000Z");
const verificationInput = (backup: { databasePath: string; manifestPath: string }, availableEncryptionKeyVersions: readonly string[]) => ({
  backupPath: backup.databasePath,
  manifestPath: backup.manifestPath,
  availableEncryptionKeyVersions,
});

const createDatabase = async (): Promise<ConnectorDatabase> => {
  const directory = await mkdtemp(join(tmpdir(), "pih-connectors-backup-db-"));
  directories.push(directory);
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  databases.push(database);
  await database.read(() => undefined);
  return database;
};

const createDestination = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), "pih-connectors-backup-dest-"));
  directories.push(parent);
  return join(parent, "backup");
};

const insertFixture = (database: ConnectorDatabase, actorId: string): Promise<unknown> =>
  database.write((handle) =>
    handle.prepare(
      "INSERT INTO user_preferences" +
        "(actor_id,time_zone,version,created_at,updated_at) " +
        "VALUES(:actorId,:timeZone,1,:now,:now)",
    ).run({
      actorId,
      timeZone: "UTC",
      now: "2026-10-12T12:00:00.000Z",
    }),
  );

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("connector backups", () => {
  it("backs up committed WAL content with migration checksums and sorted key versions", async () => {
    const database = await createDatabase();
    const destinationDirectory = await createDestination();
    const actorId = "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10";
    await insertFixture(database, actorId);

    const backup = await createConnectorBackup({
      database,
      destinationDirectory,
      encryptionKeyVersions: ["hermes-key-v1", "calendar-key-v2", "calendar-key-v2"],
      clock: fixedClock,
    });
    const manifest = await verifyConnectorBackup(verificationInput(backup, ["calendar-key-v2", "hermes-key-v1"]));
    const restored = await restoreConnectorBackup({
      ...verificationInput(backup, ["calendar-key-v2", "hermes-key-v1"]),
      targetPath: join(destinationDirectory, "restored.sqlite"),
    });
    databases.push(restored);

    expect(backup.databasePath).toBe(join(destinationDirectory, "connectors.sqlite"));
    expect(manifest).toMatchObject({
      formatVersion: 1,
      createdAt: "2026-10-12T12:34:56.000Z",
      databaseFile: "connectors.sqlite",
      encryptionKeyVersions: ["calendar-key-v2", "hermes-key-v1"],
      migrations: loadMigrations().map(({ name }) => ({ name, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) })),
    });
    expect(await restored.read((handle) =>
      handle.prepare("SELECT actor_id FROM user_preferences WHERE actor_id = :actorId")
        .get({ actorId }),
    )).toEqual({ actor_id: actorId });
    expect((await stat(destinationDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(backup.databasePath)).mode & 0o777).toBe(0o600);
  });

  it("verifies and restores a newer additive migration suffix using an older runtime bundle", async () => {
    const database = await createDatabase();
    await (await import("./migrations.js")).applyMigrations(database, [
      ...(await import("./migrations.js")).loadMigrations(),
      ...(await import("./migrations.js")).migrations({
        "9001_additive_notes": "CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT NOT NULL);",
      }),
    ]);
    await database.write((handle) => handle.prepare("INSERT INTO notes VALUES(:id,:body)").run({ id: "kept", body: "restore" }));
    const backup = await createConnectorBackup({
      database,
      destinationDirectory: await createDestination(),
      encryptionKeyVersions: [],
      clock: fixedClock,
    });
    const manifest = await verifyConnectorBackup(verificationInput(backup, []));
    const restored = await restoreConnectorBackup({
      ...verificationInput(backup, []),
      targetPath: join(dirname(backup.databasePath), "older-restore.sqlite"),
    });
    databases.push(restored);

    expect(manifest.migrations.map(({ name }) => name)).toEqual([...loadMigrations().map(({ name }) => name), "9001_additive_notes"]);
    await expect(restored.read((handle) =>
      handle.prepare("SELECT body FROM notes WHERE id = :id").get({ id: "kept" }),
    )).resolves.toEqual({ body: "restore" });
  });

  it("rejects a changed future migration checksum during backup verification", async () => {
    const database = await createDatabase();
    const { applyMigrations, loadMigrations, migrations } = await import("./migrations.js");
    await applyMigrations(database, [
      ...loadMigrations(),
      ...migrations({
        "9001_additive_notes": "CREATE TABLE notes(id TEXT PRIMARY KEY);",
      }),
    ]);
    const backup = await createConnectorBackup({
      database,
      destinationDirectory: await createDestination(),
      encryptionKeyVersions: [],
      clock: fixedClock,
    });
    const db = new DatabaseSync(backup.databasePath);
    db.prepare("UPDATE connector_migrations SET sha256 = :sha WHERE name = :name")
      .run({ name: "9001_additive_notes", sha: "f".repeat(64) });
    db.close();
    const manifest = JSON.parse(await readFile(backup.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.databaseSha256 = createHash("sha256").update(await readFile(backup.databasePath)).digest("hex");
    await writeFile(backup.manifestPath, JSON.stringify(manifest));

    await expect(verifyConnectorBackup(verificationInput(backup, [])))
      .rejects.toMatchObject({ code: "backup_migration_mismatch" });
  });

  it("rejects corrupted database bytes and unavailable encryption key versions", async () => {
    const backup = await createConnectorBackup({
      database: await createDatabase(),
      destinationDirectory: await createDestination(),
      encryptionKeyVersions: ["calendar-key-v2", "hermes-key-v1"],
      clock: fixedClock,
    });
    const intact = await readFile(backup.databasePath);
    await writeFile(backup.databasePath, Buffer.from(intact.map((byte, index) => index === 100 ? byte ^ 1 : byte)));

    await expect(verifyConnectorBackup(verificationInput(backup, ["calendar-key-v2", "hermes-key-v1"]))).rejects.toMatchObject({ code: "backup_checksum_mismatch" });
    await writeFile(backup.databasePath, intact);
    await expect(verifyConnectorBackup(verificationInput(backup, ["calendar-key-v2"]))).rejects.toMatchObject({ code: "backup_key_unavailable" });
  });

  it("refuses an existing restore target without changing it", async () => {
    const destinationDirectory = await createDestination();
    const backup = await createConnectorBackup({
      database: await createDatabase(),
      destinationDirectory,
      encryptionKeyVersions: [],
      clock: fixedClock,
    });
    const targetPath = join(destinationDirectory, "existing.sqlite");
    await writeFile(targetPath, "preserve me");

    await expect(restoreConnectorBackup({
      ...verificationInput(backup, []),
      targetPath,
    })).rejects.toMatchObject({ code: "restore_target_exists" });
    expect(await readFile(targetPath, "utf8")).toBe("preserve me");
  });

  it("rejects symlinked backup files and a strict-schema manifest with unknown fields", async () => {
    const destinationDirectory = await createDestination();
    const backup = await createConnectorBackup({
      database: await createDatabase(),
      destinationDirectory,
      encryptionKeyVersions: [],
      clock: fixedClock,
    });
    const manifest = JSON.parse(await readFile(backup.manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(backup.manifestPath, JSON.stringify({ ...manifest, unexpected: true }));
    await expect(verifyConnectorBackup(verificationInput(backup, []))).rejects.toMatchObject({ code: "backup_manifest_invalid" });

    await writeFile(backup.manifestPath, JSON.stringify(manifest));
    const linkPath = join(destinationDirectory, "linked.sqlite");
    await symlink(backup.databasePath, linkPath);
    await expect(verifyConnectorBackup({
      backupPath: linkPath,
      manifestPath: backup.manifestPath,
      availableEncryptionKeyVersions: [],
    })).rejects.toMatchObject({ code: "backup_file_invalid" });
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects an existing or symlinked destination directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pih-connectors-backup-path-"));
    directories.push(parent);
    const existing = join(parent, "existing");
    await mkdir(existing, { mode: 0o700 });
    const linked = join(parent, "linked");
    await symlink(existing, linked);

    const input = { database: await createDatabase(), encryptionKeyVersions: [], clock: fixedClock };
    await expect(createConnectorBackup({ ...input, destinationDirectory: existing }))
      .rejects.toMatchObject({ code: "backup_destination_exists" });
    await expect(createConnectorBackup({ ...input, destinationDirectory: linked }))
      .rejects.toMatchObject({ code: "backup_path_invalid" });
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
  });
  it("rejects altered applied migration checksums even when the database hash is updated", async () => {
    const destinationDirectory = await createDestination();
    const backup = await createConnectorBackup({
      database: await createDatabase(),
      destinationDirectory,
      encryptionKeyVersions: [],
      clock: fixedClock,
    });
    const db = new DatabaseSync(backup.databasePath);
    db.prepare("UPDATE connector_migrations SET sha256 = :sha").run({ sha: "f".repeat(64) });
    db.close();
    const manifest = JSON.parse(await readFile(backup.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.databaseSha256 = createHash("sha256").update(await readFile(backup.databasePath)).digest("hex");
    await writeFile(backup.manifestPath, JSON.stringify(manifest));

    await expect(verifyConnectorBackup(verificationInput(backup, [])))
      .rejects.toMatchObject({ code: "backup_migration_mismatch" });
  });

  it("rejects a restore containing foreign key violations and cleans its temporary file", async () => {
    const destinationDirectory = await createDestination();
    const backup = await createConnectorBackup({
      database: await createDatabase(),
      destinationDirectory,
      encryptionKeyVersions: [],
      clock: fixedClock,
    });
    const db = new DatabaseSync(backup.databasePath);
    db.exec("PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(7);");
    db.close();
    const manifest = JSON.parse(await readFile(backup.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.databaseSha256 = createHash("sha256").update(await readFile(backup.databasePath)).digest("hex");
    await writeFile(backup.manifestPath, JSON.stringify(manifest));
    const targetPath = join(destinationDirectory, "foreign-key-restore.sqlite");

    await expect(restoreConnectorBackup({
      ...verificationInput(backup, []),
      targetPath,
    })).rejects.toMatchObject({ code: "restore_invalid_database" });
    expect(await lstat(targetPath).catch(() => undefined)).toBeUndefined();
    expect((await readdir(destinationDirectory)).some((name) => name.startsWith(".restore-"))).toBe(false);
  });

  it("rejects symlinked backup parent directories", async () => {
    const destinationDirectory = await createDestination();
    const backup = await createConnectorBackup({
      database: await createDatabase(),
      destinationDirectory,
      encryptionKeyVersions: [],
      clock: fixedClock,
    });
    const parent = await mkdtemp(join(tmpdir(), "pih-connectors-backup-parent-"));
    directories.push(parent);
    const linked = join(parent, "linked");
    await symlink(destinationDirectory, linked);

    await expect(verifyConnectorBackup({
      backupPath: join(linked, "connectors.sqlite"),
      manifestPath: join(linked, "manifest.json"),
      availableEncryptionKeyVersions: [],
    })).rejects.toMatchObject({ code: "backup_path_invalid" });
    expect(backup.databasePath).toBe(join(destinationDirectory, "connectors.sqlite"));
  });

  it("rejects a target created while backup verification is in progress", async () => {
    const destinationDirectory = await createDestination();
    const backup = await createConnectorBackup({
      database: await createDatabase(),
      destinationDirectory,
      encryptionKeyVersions: [],
      clock: fixedClock,
    });
    const targetPath = join(destinationDirectory, "raced.sqlite");
    const raceInput = {
      ...verificationInput(backup, []),
      targetPath,
      get availableEncryptionKeyVersions() {
        return [];
      },
    };
    Object.defineProperty(raceInput, "availableEncryptionKeyVersions", {
      get() {
        // This getter runs late in verification, after restore's initial target check.
        const db = new DatabaseSync(targetPath);
        db.close();
        return [];
      },
    });

    await expect(restoreConnectorBackup(raceInput))
      .rejects.toMatchObject({ code: "restore_target_exists" });
    expect((await stat(targetPath)).isFile()).toBe(true);
  });

  it("returns a stable backup error for unreadable SQLite data with a matching hash", async () => {
    const destinationDirectory = await createDestination();
    const backup = await createConnectorBackup({
      database: await createDatabase(),
      destinationDirectory,
      encryptionKeyVersions: [],
      clock: fixedClock,
    });
    const invalidDatabase = Buffer.from("not a SQLite database");
    await writeFile(backup.databasePath, invalidDatabase);
    const manifest = JSON.parse(await readFile(backup.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.databaseSha256 = createHash("sha256").update(invalidDatabase).digest("hex");
    await writeFile(backup.manifestPath, JSON.stringify(manifest));

    await expect(verifyConnectorBackup(verificationInput(backup, [])))
      .rejects.toMatchObject({ code: "backup_migration_mismatch" });
  });

  it("streams a larger database through restore without changing its content", async () => {
    const destinationDirectory = await createDestination();
    const backup = await createConnectorBackup({
      database: await createDatabase(),
      destinationDirectory,
      encryptionKeyVersions: [],
      clock: fixedClock,
    });
    const db = new DatabaseSync(backup.databasePath);
    db.exec("CREATE TABLE payload(data BLOB NOT NULL); INSERT INTO payload VALUES(zeroblob(16777216));");
    db.close();
    const manifest = JSON.parse(await readFile(backup.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.databaseSha256 = createHash("sha256").update(await readFile(backup.databasePath)).digest("hex");
    await writeFile(backup.manifestPath, JSON.stringify(manifest));

    const restored = await restoreConnectorBackup({
      ...verificationInput(backup, []),
      targetPath: join(destinationDirectory, "large-restore.sqlite"),
    });
    databases.push(restored);
    expect(await restored.read((handle) => handle.prepare("SELECT length(data) AS size FROM payload").get()))
      .toEqual({ size: 16777216 });
  });

  it("leaves no SQLite sidecars in a completed backup directory", async () => {
    const destinationDirectory = await createDestination();
    await createConnectorBackup({
      database: await createDatabase(),
      destinationDirectory,
      encryptionKeyVersions: [],
      clock: fixedClock,
    });

    expect((await readdir(destinationDirectory)).sort()).toEqual([
      "connectors.sqlite",
      "manifest.json",
    ]);
  });

});
