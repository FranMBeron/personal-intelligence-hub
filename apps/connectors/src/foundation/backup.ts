import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  linkSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { openConnectorDatabase, type ConnectorDatabase } from "./database.js";
import {
  loadMigrations,
  validateMigrationHistory,
  type MigrationHistoryEntry,
  type MigrationHistoryMetadata,
  type MigrationRecord,
} from "./migrations.js";

export type ConnectorBackupManifest = Readonly<{
  formatVersion: 1;
  createdAt: string;
  databaseFile: "connectors.sqlite";
  databaseSha256: string;
  migrations: readonly Readonly<{ name: string; sha256: string }>[];
  encryptionKeyVersions: readonly string[];
}>;

export type BackupFailureCode =
  | "backup_path_invalid"
  | "backup_destination_exists"
  | "backup_manifest_invalid"
  | "backup_file_invalid"
  | "backup_checksum_mismatch"
  | "backup_migration_mismatch"
  | "backup_key_unavailable"
  | "restore_target_exists"
  | "restore_invalid_database";

export class ConnectorBackupError extends Error {
  readonly code: BackupFailureCode;

  constructor(code: BackupFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectorBackupError";
    this.code = code;
  }
}

export type Clock = () => Date;

type Identity = Readonly<{ dev: number; ino: number }>;
const noFollow = constants.O_NOFOLLOW ?? 0;
const namePattern = /^[0-9][A-Za-z0-9_-]*$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const fail = (code: BackupFailureCode, message: string, cause?: unknown): never => {
  throw new ConnectorBackupError(code, message, cause === undefined ? undefined : { cause });
};

const assertAbsolute = (path: string): void => {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail("backup_path_invalid", "Backup paths must be absolute normalized paths");
  }
};

const assertDirectoryChain = (path: string): void => {
  assertAbsolute(path);
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(current);
    } catch (error) {
      throw new ConnectorBackupError("backup_path_invalid", "Backup path chain must already exist", { cause: error });
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail("backup_path_invalid", "Backup path chain must contain regular directories only");
    }
  }
};

const identity = (path: string): Identity => {
  const info = lstatSync(path);
  return Object.freeze({ dev: Number(info.dev), ino: Number(info.ino) });
};

const sameIdentity = (left: Identity, right: Identity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const assertRegularFile = (path: string, expected?: Identity): Identity => {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    throw new ConnectorBackupError("backup_file_invalid", "Backup file is missing", { cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    fail("backup_file_invalid", "Backup path must name a regular non-symlink file");
  }
  const openedIdentity = Object.freeze({ dev: Number(info.dev), ino: Number(info.ino) });
  if (expected !== undefined && !sameIdentity(openedIdentity, expected)) {
    fail("backup_file_invalid", "Backup file changed during the operation");
  }
  return openedIdentity;
};

const readRegularFile = (path: string): Buffer => {
  const before = assertRegularFile(path);
  let descriptor = -1;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
  } catch (error) {
    fail("backup_file_invalid", "Unable to open backup file safely", error);
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, { dev: opened.dev, ino: opened.ino })) {
      fail("backup_file_invalid", "Backup file changed while opening");
    }
    if (fstatSync(descriptor).size > 1024 * 1024) {
      fail("backup_manifest_invalid", "Backup manifest exceeds the supported size limit");
    }
    const data = readFileSync(descriptor);
    assertRegularFile(path, before);
    return data;
  } finally {
    closeSync(descriptor);
  }
};

const hashFile = (path: string): string => {
  const before = assertRegularFile(path);
  const descriptor = openSync(path, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, { dev: Number(opened.dev), ino: Number(opened.ino) })) {
      fail("backup_file_invalid", "Backup file changed while hashing");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    assertRegularFile(path, before);
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
};

const copyAndHashFile = (sourcePath: string, targetPath: string): string => {
  const sourceBefore = assertRegularFile(sourcePath);
  const targetBefore = assertRegularFile(targetPath);
  const source = openSync(sourcePath, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
  let target = -1;
  try {
    const sourceInfo = fstatSync(source);
    if (!sourceInfo.isFile() || !sameIdentity(sourceBefore, {
      dev: Number(sourceInfo.dev),
      ino: Number(sourceInfo.ino),
    })) fail("backup_file_invalid", "Backup source changed while opening for restore");
    target = openSync(targetPath, constants.O_WRONLY | noFollow | constants.O_NONBLOCK);
    const targetInfo = fstatSync(target);
    if (!targetInfo.isFile() || !sameIdentity(targetBefore, {
      dev: Number(targetInfo.dev),
      ino: Number(targetInfo.ino),
    })) fail("backup_file_invalid", "Restore temporary file changed while opening");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = readSync(source, buffer, 0, buffer.length, null)) > 0) {
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let offset = 0;
      while (offset < bytesRead) offset += writeSync(target, chunk, offset, bytesRead - offset);
    }
    fsyncSync(target);
    assertRegularFile(sourcePath, sourceBefore);
    assertRegularFile(targetPath, targetBefore);
    return hash.digest("hex");
  } finally {
    closeSync(source);
    if (target !== -1) closeSync(target);
  }
};

const syncFile = (path: string): void => {
  const before = assertRegularFile(path);
  const descriptor = openSync(path, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, { dev: opened.dev, ino: opened.ino })) {
      fail("backup_file_invalid", "File changed before it could be synced");
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const syncDirectory = (path: string): void => {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollow);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const validateKeys = (keys: readonly string[]): readonly string[] => {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !keyPattern.test(key))) {
    fail("backup_manifest_invalid", "Encryption key versions must be non-secret identifiers");
  }
  return Object.freeze([...new Set(keys)].sort());
};

const readMigrations = (databasePath: string): readonly Readonly<{ name: string; sha256: string }>[] => {
  const before = assertRegularFile(databasePath);
  let db: DatabaseSync | undefined;
  try {
    const immutablePath = pathToFileURL(databasePath).href + "?immutable=1";
    db = new DatabaseSync(immutablePath, { readOnly: true, allowExtension: false });
    const rows = db.prepare("SELECT name, sha256 FROM connector_migrations ORDER BY name").all() as {
      name: unknown;
      sha256: unknown;
    }[];
    if (rows.some((row) => typeof row.name !== "string" || !namePattern.test(row.name) ||
      typeof row.sha256 !== "string" || !shaPattern.test(row.sha256))) {
      fail("backup_migration_mismatch", "Backup contains invalid migration records");
    }
    const hasTable = (name: string): boolean => db!.prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=:name",
    ).get({ name }) !== undefined;
    const hasHistory = hasTable("connector_migration_history");
    const hasMetadata = hasTable("connector_migration_history_metadata");
    const state: { entries?: readonly MigrationHistoryEntry[]; metadata?: MigrationHistoryMetadata } = {};
    if (hasHistory) {
      state.entries = db.prepare(
        "SELECT sequence, name, sha256, previous_sha256 AS previousSha256, entry_sha256 AS entrySha256 " +
          "FROM connector_migration_history ORDER BY sequence",
      ).all() as MigrationHistoryEntry[];
    }
    if (hasMetadata) {
      const metadata = db.prepare(
        "SELECT singleton_id AS singletonId, format_version AS formatVersion, applied_count AS appliedCount, " +
          "head_sha256 AS headSha256 FROM connector_migration_history_metadata",
      ).all() as MigrationHistoryMetadata[];
      if (metadata.length !== 1 || metadata[0] === undefined) {
        fail("backup_migration_mismatch", "Backup migration metadata is invalid");
      }
      state.metadata = metadata[0]!;
    }
    const validated = validateMigrationHistory(rows as MigrationRecord[], state, loadMigrations());
    assertRegularFile(databasePath, before);
    return Object.freeze(validated.map(({ name, sha256 }) => Object.freeze({ name, sha256 })));
  } catch (error) {
    if (error instanceof ConnectorBackupError) throw error;
    return fail("backup_migration_mismatch", "Backup database migration records could not be verified", error);
  } finally {
    db?.close();
  }
};

const parseManifest = (raw: Buffer): ConnectorBackupManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    fail("backup_manifest_invalid", "Backup manifest is not valid JSON", error);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("backup_manifest_invalid", "Backup manifest must be an object");
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = ["createdAt", "databaseFile", "databaseSha256", "encryptionKeyVersions", "formatVersion", "migrations"];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0") ||
    value.formatVersion !== 1 || typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt ||
    value.databaseFile !== "connectors.sqlite" || typeof value.databaseSha256 !== "string" ||
    !shaPattern.test(value.databaseSha256) || !Array.isArray(value.encryptionKeyVersions) ||
    !Array.isArray(value.migrations)) {
    fail("backup_manifest_invalid", "Backup manifest does not match the supported schema");
  }
  const keys = value.encryptionKeyVersions as unknown[];
  if (keys.some((key) => typeof key !== "string" || !keyPattern.test(key)) ||
    new Set(keys).size !== keys.length || [...keys].sort().join("\0") !== keys.join("\0")) {
    fail("backup_manifest_invalid", "Backup manifest contains invalid key versions");
  }
  const migrations = value.migrations as unknown[];
  let previous = "";
  for (const migration of migrations) {
    if (migration === null || typeof migration !== "object" || Array.isArray(migration) ||
      Object.keys(migration).sort().join("\0") !== "name\0sha256") {
      fail("backup_manifest_invalid", "Backup manifest contains invalid migration records");
    }
    const item = migration as Record<string, unknown>;
    if (typeof item.name !== "string" || !namePattern.test(item.name) || item.name <= previous ||
      typeof item.sha256 !== "string" || !shaPattern.test(item.sha256)) {
      fail("backup_manifest_invalid", "Backup manifest migrations must be unique and sorted");
    }
    previous = item.name as string;
  }
  return Object.freeze({
    formatVersion: 1,
    createdAt: value.createdAt as string,
    databaseFile: "connectors.sqlite",
    databaseSha256: value.databaseSha256 as string,
    migrations: Object.freeze(migrations.map((migration) => Object.freeze({
      name: (migration as { name: string }).name,
      sha256: (migration as { sha256: string }).sha256,
    }))),
    encryptionKeyVersions: Object.freeze([...keys] as string[]),
  });
};

export async function createConnectorBackup(input: Readonly<{
  database: ConnectorDatabase;
  destinationDirectory: string;
  encryptionKeyVersions: readonly string[];
  clock: Clock;
}>): Promise<Readonly<{ databasePath: string; manifestPath: string }>> {
  const directory = input.destinationDirectory;
  assertAbsolute(directory);
  assertDirectoryChain(dirname(directory));
  try {
    const existing = lstatSync(directory);
    if (existing.isSymbolicLink()) fail("backup_path_invalid", "Backup destination cannot be a symbolic link");
    fail("backup_destination_exists", "Backup destination directory already exists");
  } catch (error) {
    if (error instanceof ConnectorBackupError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("backup_path_invalid", "Unable to inspect backup destination", error);
  }
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("backup_destination_exists", "Backup destination directory already exists", error);
    }
    fail("backup_path_invalid", "Unable to create backup destination directory", error);
  }
  const directoryIdentity = identity(directory);
  let databaseIdentity: Identity | undefined;
  let manifestTemp: string | undefined;
  let manifestTempIdentity: Identity | undefined;
  let publishedManifestIdentity: Identity | undefined;
  const databasePath = join(directory, "connectors.sqlite");
  const manifestPath = join(directory, "manifest.json");
  try {
    if ((lstatSync(directory).mode & 0o777) !== 0o700 || readdirSync(directory).length !== 0) {
      fail("backup_path_invalid", "Backup directory must be empty and mode 0700");
    }
    await input.database.backupTo(databasePath);
    databaseIdentity = assertRegularFile(databasePath);
    syncFile(databasePath);
    const migrations = readMigrations(databasePath);
    const keys = validateKeys(input.encryptionKeyVersions);
    const createdAt = input.clock().toISOString();
    if (!Number.isFinite(Date.parse(createdAt))) fail("backup_manifest_invalid", "Clock returned an invalid date");
    const manifest: ConnectorBackupManifest = Object.freeze({
      formatVersion: 1,
      createdAt,
      databaseFile: "connectors.sqlite",
      databaseSha256: hashFile(databasePath),
      migrations,
      encryptionKeyVersions: keys,
    });
    const temporary = join(directory, ".manifest-" + randomUUID() + ".tmp");
    manifestTemp = temporary;
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    try {
      manifestTempIdentity = Object.freeze({ dev: fstatSync(descriptor).dev, ino: fstatSync(descriptor).ino });
      writeFileSync(descriptor, JSON.stringify(manifest) + "\n", "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, manifestPath);
    manifestTemp = undefined;
    publishedManifestIdentity = identity(manifestPath);
    syncDirectory(directory);
    if (!sameIdentity(directoryIdentity, identity(directory))) fail("backup_path_invalid", "Backup directory changed during creation");
    return Object.freeze({ databasePath, manifestPath });
  } catch (error) {
    if (manifestTemp !== undefined && manifestTempIdentity !== undefined) {
      try {
        if (sameIdentity(manifestTempIdentity, identity(manifestTemp))) unlinkSync(manifestTemp);
      } catch { /* Preserve the original failure. */ }
    }
    if (databaseIdentity !== undefined) {
      try {
        if (sameIdentity(databaseIdentity, identity(databasePath))) unlinkSync(databasePath);
      } catch { /* Preserve the original failure. */ }
    }
    if (publishedManifestIdentity !== undefined) {
      try {
        if (sameIdentity(publishedManifestIdentity, identity(manifestPath))) unlinkSync(manifestPath);
      } catch { /* Preserve the original failure. */ }
    }
    try {
      if (sameIdentity(directoryIdentity, identity(directory)) && readdirSync(directory).length === 0) {
        rmdirSync(directory);
      }
    } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

export async function verifyConnectorBackup(input: Readonly<{
  backupPath: string;
  manifestPath: string;
  availableEncryptionKeyVersions: readonly string[];
}>): Promise<ConnectorBackupManifest> {
  assertAbsolute(input.backupPath);
  assertAbsolute(input.manifestPath);
  const directory = dirname(input.backupPath);
  if (dirname(input.manifestPath) !== directory || basename(input.backupPath) !== "connectors.sqlite" || basename(input.manifestPath) !== "manifest.json") {
    fail("backup_file_invalid", "Backup database and manifest must use their fixed names in one directory");
  }
  assertDirectoryChain(directory);
  const dbIdentity = assertRegularFile(input.backupPath);
  const manifestIdentity = assertRegularFile(input.manifestPath);
  const manifest = parseManifest(readRegularFile(input.manifestPath));
  if (!sameIdentity(dbIdentity, identity(input.backupPath)) || !sameIdentity(manifestIdentity, identity(input.manifestPath))) {
    fail("backup_file_invalid", "Backup files changed during verification");
  }
  if (hashFile(input.backupPath) !== manifest.databaseSha256) {
    fail("backup_checksum_mismatch", "Backup database SHA-256 does not match the manifest");
  }
  const databaseMigrations = readMigrations(input.backupPath);
  if (JSON.stringify(databaseMigrations) !== JSON.stringify(manifest.migrations)) {
    fail("backup_migration_mismatch", "Manifest migration checksums do not match the backup database");
  }
  const available = new Set(validateKeys(input.availableEncryptionKeyVersions));
  if (manifest.encryptionKeyVersions.some((version) => !available.has(version))) {
    fail("backup_key_unavailable", "A required encryption key version is unavailable");
  }
  return manifest;
}

export async function restoreConnectorBackup(input: Readonly<{
  backupPath: string;
  manifestPath: string;
  targetPath: string;
  availableEncryptionKeyVersions: readonly string[];
}>): Promise<ConnectorDatabase> {
  assertAbsolute(input.targetPath);
  const directory = dirname(input.targetPath);
  assertDirectoryChain(directory);
  try {
    lstatSync(input.targetPath);
    fail("restore_target_exists", "Restore target already exists");
  } catch (error) {
    if (error instanceof ConnectorBackupError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("backup_path_invalid", "Unable to inspect restore target", error);
  }
  const verifiedManifest = await verifyConnectorBackup(input);
  const directoryId = identity(directory);
  const temporary = join(directory, ".restore-" + randomUUID() + ".tmp");
  let tempIdentity: Identity | undefined;
  let restored: ConnectorDatabase | undefined;
  try {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow, 0o600);
    try {
      const opened = fstatSync(descriptor);
      tempIdentity = Object.freeze({ dev: Number(opened.dev), ino: Number(opened.ino) });
    }
    finally { closeSync(descriptor); }
    if (copyAndHashFile(input.backupPath, temporary) !== verifiedManifest.databaseSha256) {
      fail("backup_checksum_mismatch", "Backup changed after verification");
    }
    if (hashFile(temporary) !== verifiedManifest.databaseSha256 ||
      JSON.stringify(readMigrations(temporary)) !== JSON.stringify(verifiedManifest.migrations)) {
      fail("backup_checksum_mismatch", "Temporary restore copy differs from the verified backup");
    }
    restored = openConnectorDatabase(temporary);
    const integrity = await restored.read((handle) => ({
      result: handle.prepare("PRAGMA integrity_check").get<Record<string, string>>(),
      foreignKeys: handle.prepare("PRAGMA foreign_key_check").all<Record<string, unknown>>(),
    }));
    if (Object.values(integrity.result ?? {})[0] !== "ok" || integrity.foreignKeys.length !== 0) {
      fail("restore_invalid_database", "Restored database failed SQLite integrity checks");
    }
    await restored.close();
    restored = undefined;
    syncFile(temporary);
    if (!sameIdentity(directoryId, identity(directory))) fail("backup_path_invalid", "Restore directory changed during restore");
    try {
      linkSync(temporary, input.targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("restore_target_exists", "Restore target already exists", error);
      throw error;
    }
    unlinkSync(temporary);
    tempIdentity = undefined;
    syncDirectory(directory);
    return openConnectorDatabase(input.targetPath);
  } catch (error) {
    if (restored !== undefined) await restored.close().catch(() => undefined);
    if (tempIdentity !== undefined) {
      try { if (sameIdentity(tempIdentity, identity(temporary))) unlinkSync(temporary); }
      catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
}
