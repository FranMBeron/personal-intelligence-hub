import { lstatSync } from "node:fs";

import { loadConnectorsConfig, type ConnectorsConfig } from "../config/private.js";
import {
  createConnectorBackup,
  verifyConnectorBackup,
  type Clock,
  type ConnectorBackupManifest,
} from "../foundation/backup.js";
import { openConnectorDatabase } from "../foundation/database.js";
import { providerConfigNamespaces } from "../providers.js";
import {
  OperatorCommandError,
  failureCode,
  isEntryPoint,
  parseOptions,
  requireAbsolutePath,
  writeJsonLine,
  type OperatorCommandIo,
} from "./command-line.js";
import { collectConfiguredEncryptionKeyVersions } from "./encryption-key-versions.js";

const assertExistingDatabase = (databasePath: string): void => {
  let regularFile = false;
  try {
    const info = lstatSync(databasePath);
    regularFile = info.isFile() && !info.isSymbolicLink();
  } catch {
    regularFile = false;
  }
  // Opening a missing path would create and migrate an empty database.
  if (!regularFile) throw new OperatorCommandError("backup_database_missing", "Live connector database is missing");
};

/**
 * Create a verified plaintext snapshot in a caller-selected new staging
 * directory. Backup, manifest and verification logic belong to the Foundation
 * contract; this adapter only opens, delegates and closes.
 */
export async function runBackupCommand(input: Readonly<{
  databasePath: string;
  destinationDirectory: string;
  encryptionKeyVersions: readonly string[];
  clock: Clock;
}>): Promise<Readonly<{ databasePath: string; manifestPath: string }>> {
  return (await backupAndVerify(input)).paths;
}

const backupAndVerify = async (input: Parameters<typeof runBackupCommand>[0]): Promise<Readonly<{
  paths: Readonly<{ databasePath: string; manifestPath: string }>;
  manifest: ConnectorBackupManifest;
}>> => {
  requireAbsolutePath(input.databasePath);
  requireAbsolutePath(input.destinationDirectory);
  assertExistingDatabase(input.databasePath);
  const database = openConnectorDatabase(input.databasePath);
  try {
    const paths = await createConnectorBackup({
      database,
      destinationDirectory: input.destinationDirectory,
      encryptionKeyVersions: input.encryptionKeyVersions,
      clock: input.clock,
    });
    const manifest = await verifyConnectorBackup({
      backupPath: paths.databasePath,
      manifestPath: paths.manifestPath,
      availableEncryptionKeyVersions: input.encryptionKeyVersions,
    });
    return Object.freeze({ paths, manifest });
  } finally {
    await database.close();
  }
};

export const loadOperatorConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): ConnectorsConfig => {
  try {
    return loadConnectorsConfig(environment, providerConfigNamespaces);
  } catch {
    throw new OperatorCommandError("configuration_invalid", "Connector configuration is invalid");
  }
};

export const manifestSummary = (manifest: ConnectorBackupManifest): Readonly<Record<string, unknown>> => ({
  formatVersion: manifest.formatVersion,
  createdAt: manifest.createdAt,
  migrationCount: manifest.migrations.length,
  encryptionKeyVersions: manifest.encryptionKeyVersions,
  databaseSha256: manifest.databaseSha256,
});

export const backupCommandMain = async (input: OperatorCommandIo & Readonly<{
  argv: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
}>): Promise<number> => {
  try {
    const options = parseOptions(input.argv, ["destination"], ["database"]);
    const destinationDirectory = requireAbsolutePath(options.get("destination") ?? "");
    const config = loadOperatorConfig(input.environment);
    const expectedDatabase = options.get("database");
    if (expectedDatabase !== undefined && requireAbsolutePath(expectedDatabase) !== config.databasePath) {
      throw new OperatorCommandError("backup_database_mismatch", "Database argument differs from configuration");
    }
    const { manifest } = await backupAndVerify({
      databasePath: config.databasePath,
      destinationDirectory,
      encryptionKeyVersions: collectConfiguredEncryptionKeyVersions(config),
      clock: input.clock ?? (() => new Date()),
    });
    writeJsonLine(input.stdout, { result: "backup_complete", ...manifestSummary(manifest) });
    return 0;
  } catch (error) {
    writeJsonLine(input.stderr, { result: "backup_failed", reason: failureCode(error, "backup_failed_unexpected") });
    return 1;
  }
};

if (isEntryPoint(import.meta.url)) {
  void backupCommandMain({
    argv: process.argv.slice(2),
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  }).then((code) => {
    process.exitCode = code;
  });
}
