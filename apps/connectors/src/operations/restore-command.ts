import { restoreConnectorBackup, verifyConnectorBackup } from "../foundation/backup.js";
import { loadOperatorConfig, manifestSummary } from "./backup-command.js";
import {
  failureCode,
  isEntryPoint,
  parseOptions,
  requireAbsolutePath,
  writeJsonLine,
  type OperatorCommandIo,
} from "./command-line.js";
import { collectConfiguredEncryptionKeyVersions } from "./encryption-key-versions.js";

/**
 * Restore a verified snapshot into a new target path. The Foundation contract
 * verifies checksum, migrations, key availability and integrity, and refuses
 * an existing target; this adapter never weakens those checks.
 */
export async function runRestoreCommand(input: Readonly<{
  backupPath: string;
  manifestPath: string;
  targetPath: string;
  availableEncryptionKeyVersions: readonly string[];
}>): Promise<void> {
  requireAbsolutePath(input.backupPath);
  requireAbsolutePath(input.manifestPath);
  requireAbsolutePath(input.targetPath);
  const restored = await restoreConnectorBackup(input);
  await restored.close();
}

export const restoreCommandMain = async (input: OperatorCommandIo & Readonly<{
  argv: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
}>): Promise<number> => {
  try {
    const options = parseOptions(input.argv, ["backup", "manifest", "target"]);
    const backupPath = requireAbsolutePath(options.get("backup") ?? "");
    const manifestPath = requireAbsolutePath(options.get("manifest") ?? "");
    const targetPath = requireAbsolutePath(options.get("target") ?? "");
    const config = loadOperatorConfig(input.environment);
    const availableEncryptionKeyVersions = collectConfiguredEncryptionKeyVersions(config);
    // Verify first so the summary describes exactly the snapshot that is restored.
    const manifest = await verifyConnectorBackup({ backupPath, manifestPath, availableEncryptionKeyVersions });
    await runRestoreCommand({ backupPath, manifestPath, targetPath, availableEncryptionKeyVersions });
    writeJsonLine(input.stdout, { result: "restore_complete", ...manifestSummary(manifest) });
    return 0;
  } catch (error) {
    writeJsonLine(input.stderr, { result: "restore_failed", reason: failureCode(error, "restore_failed_unexpected") });
    return 1;
  }
};

if (isEntryPoint(import.meta.url)) {
  void restoreCommandMain({
    argv: process.argv.slice(2),
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  }).then((code) => {
    process.exitCode = code;
  });
}
