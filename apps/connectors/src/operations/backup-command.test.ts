import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as backupContract from "../foundation/backup.js";
import { openConnectorDatabase } from "../foundation/database.js";
import {
  fictionalCalendarEnvironment,
  fictionalOperatorEnvironment,
  fictionalSecretMarkers,
} from "../../test/operations/fixtures.js";
import { backupCommandMain, runBackupCommand } from "./backup-command.js";
import { restoreCommandMain, runRestoreCommand } from "./restore-command.js";

const directories: string[] = [];
const fixedClock = () => new Date("2026-10-12T08:00:00.000Z");
const fixtureActor = "00000000-0000-4000-8000-0000000000f1";
const fixtureRowMarker = "Fictional/Row_Zone";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
};

/** A live WAL database with one committed fictional row. */
const liveDatabase = async (): Promise<string> => {
  const directory = await temporaryDirectory("pih-ops-live-");
  const databasePath = join(directory, "connectors.sqlite");
  const database = openConnectorDatabase(databasePath);
  try {
    await database.write((handle) => handle.prepare(
      "INSERT INTO user_preferences(actor_id,time_zone,version,created_at,updated_at) " +
        "VALUES(:actor,:zone,1,:now,:now)",
    ).run({ actor: fixtureActor, zone: fixtureRowMarker, now: "2026-10-12T07:00:00.000Z" }));
  } finally {
    await database.close();
  }
  return databasePath;
};

const restoredRows = async (path: string): Promise<unknown[]> => {
  const database = openConnectorDatabase(path);
  try {
    return [...await database.read((handle) => handle.prepare(
      "SELECT actor_id AS id, time_zone AS zone FROM user_preferences ORDER BY actor_id",
    ).all<Record<string, unknown>>())];
  } finally {
    await database.close();
  }
};

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: { write: (value: string) => out.push(value) }, stderr: { write: (value: string) => err.push(value) } },
    output: () => out.join("") + err.join(""),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
};

describe("runBackupCommand and runRestoreCommand", () => {
  it("round-trips committed rows through the Foundation contract", async () => {
    const createSpy = vi.spyOn(backupContract, "createConnectorBackup");
    const verifySpy = vi.spyOn(backupContract, "verifyConnectorBackup");
    const restoreSpy = vi.spyOn(backupContract, "restoreConnectorBackup");
    const databasePath = await liveDatabase();
    const staging = await temporaryDirectory("pih-ops-staging-");

    const result = await runBackupCommand({
      databasePath,
      destinationDirectory: join(staging, "snapshot"),
      encryptionKeyVersions: ["test-key-v1"],
      clock: fixedClock,
    });
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
      formatVersion: 1,
      createdAt: "2026-10-12T08:00:00.000Z",
      encryptionKeyVersions: ["test-key-v1"],
    });

    const targetDirectory = await temporaryDirectory("pih-ops-target-");
    const targetPath = join(targetDirectory, "connectors.sqlite");
    await runRestoreCommand({
      backupPath: result.databasePath,
      manifestPath: result.manifestPath,
      targetPath,
      availableEncryptionKeyVersions: ["test-key-v1"],
    });
    expect(await restoredRows(targetPath)).toEqual([{ id: fixtureActor, zone: fixtureRowMarker }]);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalled();
    expect(restoreSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a truncated snapshot without creating the target", async () => {
    const databasePath = await liveDatabase();
    const staging = await temporaryDirectory("pih-ops-staging-");
    const result = await runBackupCommand({
      databasePath,
      destinationDirectory: join(staging, "snapshot"),
      encryptionKeyVersions: ["test-key-v1"],
      clock: fixedClock,
    });
    await truncate(result.databasePath, 1024);
    const targetPath = join(await temporaryDirectory("pih-ops-target-"), "connectors.sqlite");
    await expect(runRestoreCommand({
      backupPath: result.databasePath,
      manifestPath: result.manifestPath,
      targetPath,
      availableEncryptionKeyVersions: ["test-key-v1"],
    })).rejects.toMatchObject({ code: "backup_checksum_mismatch" });
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unavailable key version and never overwrites an existing target", async () => {
    const databasePath = await liveDatabase();
    const staging = await temporaryDirectory("pih-ops-staging-");
    const result = await runBackupCommand({
      databasePath,
      destinationDirectory: join(staging, "snapshot"),
      encryptionKeyVersions: ["calendar:fictional-key-1"],
      clock: fixedClock,
    });
    const targetDirectory = await temporaryDirectory("pih-ops-target-");
    await expect(runRestoreCommand({
      backupPath: result.databasePath,
      manifestPath: result.manifestPath,
      targetPath: join(targetDirectory, "connectors.sqlite"),
      availableEncryptionKeyVersions: ["calendar:other-key"],
    })).rejects.toMatchObject({ code: "backup_key_unavailable" });

    const existing = join(targetDirectory, "existing.sqlite");
    await writeFile(existing, "existing-operator-data");
    await expect(runRestoreCommand({
      backupPath: result.databasePath,
      manifestPath: result.manifestPath,
      targetPath: existing,
      availableEncryptionKeyVersions: ["calendar:fictional-key-1"],
    })).rejects.toMatchObject({ code: "restore_target_exists" });
    expect(await readFile(existing, "utf8")).toBe("existing-operator-data");
  });

  it("rejects relative paths and a missing live database before opening anything", async () => {
    const staging = await temporaryDirectory("pih-ops-staging-");
    await expect(runBackupCommand({
      databasePath: "connectors.sqlite",
      destinationDirectory: join(staging, "snapshot"),
      encryptionKeyVersions: [],
      clock: fixedClock,
    })).rejects.toMatchObject({ code: "backup_path_invalid" });
    await expect(runBackupCommand({
      databasePath: join(staging, "missing.sqlite"),
      destinationDirectory: join(staging, "snapshot"),
      encryptionKeyVersions: [],
      clock: fixedClock,
    })).rejects.toMatchObject({ code: "backup_database_missing" });
    await expect(readFile(join(staging, "missing.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runRestoreCommand({
      backupPath: "snapshot/connectors.sqlite",
      manifestPath: "snapshot/manifest.json",
      targetPath: join(staging, "connectors.sqlite"),
      availableEncryptionKeyVersions: [],
    })).rejects.toMatchObject({ code: "backup_path_invalid" });
  });
});

describe("operator command line", () => {
  it("backs up and restores with configuration-derived key versions and sanitized output only", async () => {
    const databasePath = await liveDatabase();
    const uploadDirectory = await temporaryDirectory("pih-ops-upload-");
    const environment = fictionalOperatorEnvironment(databasePath, {
      ...fictionalCalendarEnvironment(),
      HERMES_UPLOAD_DIRECTORY: uploadDirectory,
    });
    const staging = await temporaryDirectory("pih-ops-staging-");
    const destination = join(staging, "snapshot");
    const backup = capture();

    expect(await backupCommandMain({
      argv: ["--destination", destination, "--database", databasePath],
      environment,
      clock: fixedClock,
      ...backup.io,
    })).toBe(0);
    const summary = JSON.parse(backup.stdout()) as Record<string, unknown>;
    expect(summary).toEqual({
      result: "backup_complete",
      formatVersion: 1,
      createdAt: "2026-10-12T08:00:00.000Z",
      migrationCount: expect.any(Number),
      encryptionKeyVersions: ["calendar:fictional-key-1", "calendar:fictional-key-2"],
      databaseSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const targetPath = join(await temporaryDirectory("pih-ops-target-"), "connectors.sqlite");
    const restore = capture();
    expect(await restoreCommandMain({
      argv: [
        "--backup", join(destination, "connectors.sqlite"),
        "--manifest", join(destination, "manifest.json"),
        "--target", targetPath,
      ],
      environment,
      ...restore.io,
    })).toBe(0);
    expect(JSON.parse(restore.stdout())).toMatchObject({
      result: "restore_complete",
      databaseSha256: summary.databaseSha256,
    });
    expect(await restoredRows(targetPath)).toEqual([{ id: fixtureActor, zone: fixtureRowMarker }]);

    for (const output of [backup.output(), restore.output()]) {
      expect(output).not.toContain(fixtureRowMarker);
      expect(output).not.toContain(fixtureActor);
      for (const [name, value] of Object.entries(environment)) {
        // Key version identifiers are non-secret by design and are the only configuration echoed.
        if (name === "GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID") continue;
        if (value.length > 8 && !/^\d+$/u.test(value)) expect(output).not.toContain(value);
      }
      for (const marker of fictionalSecretMarkers) expect(output).not.toContain(marker);
    }
  });

  it("refuses a database argument that differs from the validated configuration", async () => {
    const databasePath = await liveDatabase();
    const staging = await temporaryDirectory("pih-ops-staging-");
    const result = capture();
    expect(await backupCommandMain({
      argv: ["--destination", join(staging, "snapshot"), "--database", join(staging, "other.sqlite")],
      environment: fictionalOperatorEnvironment(databasePath),
      clock: fixedClock,
      ...result.io,
    })).toBe(1);
    expect(JSON.parse(result.stderr())).toEqual({ result: "backup_failed", reason: "backup_database_mismatch" });
  });

  it.each([
    [[], "arguments_invalid"],
    [["--destination"], "arguments_invalid"],
    [["--destination", "relative/snapshot"], "backup_path_invalid"],
    [["--destination", "/tmp/a", "--destination", "/tmp/b"], "arguments_invalid"],
    [["--unknown", "/tmp/a"], "arguments_invalid"],
  ])("rejects malformed backup arguments %j with a safe reason", async (argv, reason) => {
    const databasePath = await liveDatabase();
    const result = capture();
    expect(await backupCommandMain({
      argv,
      environment: fictionalOperatorEnvironment(databasePath),
      clock: fixedClock,
      ...result.io,
    })).toBe(1);
    expect(JSON.parse(result.stderr())).toEqual({ result: "backup_failed", reason });
    expect(result.stdout()).toBe("");
  });

  it("reports configuration failures without echoing configuration values", async () => {
    const databasePath = await liveDatabase();
    const staging = await temporaryDirectory("pih-ops-staging-");
    const result = capture();
    const environment = fictionalOperatorEnvironment(databasePath, {
      ...fictionalCalendarEnvironment(),
      GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: "http://fictional-secret-host.example.test/callback",
    });
    expect(await backupCommandMain({
      argv: ["--destination", join(staging, "snapshot")],
      environment,
      clock: fixedClock,
      ...result.io,
    })).toBe(1);
    expect(JSON.parse(result.stderr())).toEqual({ result: "backup_failed", reason: "configuration_invalid" });
    expect(result.output()).not.toContain("fictional-secret-host");
  });

  it("refuses restore into an existing target and emits only the reason code", async () => {
    const databasePath = await liveDatabase();
    const staging = await temporaryDirectory("pih-ops-staging-");
    const environment = fictionalOperatorEnvironment(databasePath);
    const destination = join(staging, "snapshot");
    expect(await backupCommandMain({
      argv: ["--destination", destination], environment, clock: fixedClock, ...capture().io,
    })).toBe(0);
    await mkdir(join(staging, "target"));
    const existing = join(staging, "target", "connectors.sqlite");
    await writeFile(existing, "keep");
    const result = capture();
    expect(await restoreCommandMain({
      argv: [
        "--backup", join(destination, "connectors.sqlite"),
        "--manifest", join(destination, "manifest.json"),
        "--target", existing,
      ],
      environment,
      ...result.io,
    })).toBe(1);
    expect(JSON.parse(result.stderr())).toEqual({ result: "restore_failed", reason: "restore_target_exists" });
    expect(await readFile(existing, "utf8")).toBe("keep");
  });
});
