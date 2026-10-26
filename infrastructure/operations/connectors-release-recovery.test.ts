import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  candidateSha,
  createReleaseFixture,
  oldSha,
  operationsRoot,
  type ReleaseFixture,
} from "./release-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fixture = async (options?: Parameters<typeof createReleaseFixture>[0]): Promise<ReleaseFixture> => {
  const created = await createReleaseFixture(options);
  roots.push(created.root);
  return created;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Translate raw fake-command events into the release-flow vocabulary. */
const releaseEvents = (raw: readonly string[]): string[] => raw.flatMap((line) => {
  if (line.startsWith("backup-adapter ")) return ["snapshot-created"];
  if (line.startsWith("restic check")) return ["backup-complete"];
  if (line === `systemctl stop ${oldSha}`) return ["old-service-stopped"];
  if (line === `systemctl restart ${candidateSha}`) return ["candidate-started"];
  if (line === `readiness-failed ${candidateSha}`) return ["candidate-readiness-failed"];
  if (line === `readiness-ok ${candidateSha}`) return ["candidate-ready"];
  if (line.startsWith("restore-adapter ")) return ["snapshot-restored"];
  if (line === `readiness-ok ${oldSha}`) return ["previous-service-ready"];
  if (/^docker compose .* up /u.test(line)) return ["web-rollout"];
  return [];
});

describe("connectors upgrade with database recovery", () => {
  it("backs up into encrypted Restic before stopping the old service and never restores on success", async () => {
    const release = await fixture();
    await release.run("deploy-release.sh", [candidateSha]);

    const raw = await release.events();
    const events = releaseEvents(raw);
    expect(events).toEqual([
      "snapshot-created",
      "backup-complete",
      "old-service-stopped",
      "candidate-started",
      "candidate-ready",
      "web-rollout",
    ]);
    const backupCall = raw.find((line) => line.startsWith("restic backup "));
    expect(backupCall).toContain(`--tag pre-activation-${candidateSha}`);
    expect(backupCall).toContain(`--tag ${oldSha}`);
    expect(backupCall).toContain("--tag personal-intelligence-hub");
    expect(raw.some((line) => line.startsWith("restore-adapter"))).toBe(false);
    expect(raw.find((line) => line.startsWith("backup-adapter"))).toBe(`backup-adapter ${oldSha}`);

    const manifest = JSON.parse(await readFile(join(release.candidateRelease, "release-manifest.json"), "utf8"));
    expect(manifest.connectors.preActivationSnapshot).toEqual({
      resticSnapshotId: expect.stringMatching(/^[0-9a-f]{64}$/u),
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(Object.keys(manifest.connectors.preActivationSnapshot)).toEqual(["resticSnapshotId", "manifestSha256"]);
    const archived = await readFile(join(
      release.resticRepository,
      manifest.connectors.preActivationSnapshot.resticSnapshotId,
      "tags",
    ), "utf8");
    expect(archived).toContain(`pre-activation-${candidateSha}`);
    expect(await release.stagingLeftovers()).toEqual([]);
    expect(await readlink(join(release.connectorsRoot, "current"))).toBe(release.candidateRuntime);
  });

  it("restores the verified snapshot, previous runtime and service state when candidate readiness fails", async () => {
    const release = await fixture();
    await expect(release.run("deploy-release.sh", [candidateSha], { READINESS_FAIL_AT: "1" }))
      .rejects.toMatchObject({ code: 1 });

    const events = releaseEvents(await release.events());
    expect(events).toEqual(expect.arrayContaining([
      "backup-complete",
      "old-service-stopped",
      "candidate-started",
      "candidate-readiness-failed",
      "snapshot-restored",
      "previous-service-ready",
    ]));
    expect(events.indexOf("backup-complete")).toBeLessThan(events.indexOf("old-service-stopped"));
    expect(events.indexOf("candidate-readiness-failed")).toBeLessThan(events.indexOf("snapshot-restored"));
    expect(events.indexOf("snapshot-restored")).toBeLessThan(events.indexOf("previous-service-ready"));
    expect(events).not.toContain("web-rollout");
    expect(await readFile(release.databasePath, "utf8")).toBe("old-data\n");
    expect(await readFile(`${release.databasePath}.failed-${candidateSha}`, "utf8")).toBe("old-data\ncandidate-migrated\n");
    expect(await readlink(join(release.connectorsRoot, "current"))).toBe(release.oldRuntime);
    expect((await readFile(release.systemdState, "utf8")).trim()).toBe("enabled active");
    expect(await release.stagingLeftovers()).toEqual([]);
    expect(await readlink(join(release.root, "current"))).toBe(release.oldRelease);
  });

  it("leaves connectors stopped with the quarantine and Restic snapshot intact when restore fails", async () => {
    const release = await fixture();
    const failure = await release.run("deploy-release.sh", [candidateSha], {
      READINESS_FAIL_AT: "1",
      FAIL_RESTORE_ADAPTER: "1",
    }).catch((error: { code: number; stderr: string }) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toContain("reason=connectors_database_restore_failed");
    expect(await exists(release.databasePath)).toBe(false);
    expect(await readFile(`${release.databasePath}.failed-${candidateSha}`, "utf8")).toContain("candidate-migrated");
    expect((await readFile(release.systemdState, "utf8")).trim()).toBe("disabled inactive");
    const raw = await release.events();
    // Recovery never forgets the specific snapshot, and no retention runs after the restore attempt.
    expect(raw.some((line) => line.startsWith("restic forget") && line.includes(`pre-activation-${candidateSha}`))).toBe(false);
    const restoreAttempt = raw.findIndex((line) => line.startsWith("restore-adapter"));
    expect(raw.slice(restoreAttempt).some((line) => line.startsWith("restic forget"))).toBe(false);
    const manifest = JSON.parse(await readFile(join(release.candidateRelease, "release-manifest.json"), "utf8"));
    expect(await exists(join(release.resticRepository, manifest.connectors.preActivationSnapshot.resticSnapshotId))).toBe(true);
    expect(raw.filter((line) => line.startsWith("readiness-ok"))).toEqual([]);
    expect(await release.stagingLeftovers()).toEqual([]);
  });

  it("leaves connectors stopped when the restored previous service is not ready", async () => {
    const release = await fixture();
    const failure = await release.run("deploy-release.sh", [candidateSha], { READINESS_FAIL_AT: "1 2" })
      .catch((error: { code: number; stderr: string }) => error);
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toContain("reason=previous_connectors_not_ready");
    expect(await readFile(release.databasePath, "utf8")).toBe("old-data\n");
    expect(await readFile(`${release.databasePath}.failed-${candidateSha}`, "utf8")).toContain("candidate-migrated");
    expect((await readFile(release.systemdState, "utf8")).trim()).toBe("enabled inactive");
    expect(await release.stagingLeftovers()).toEqual([]);
  });

  it("does not stop the old service when the encrypted backup fails", async () => {
    const release = await fixture();
    await expect(release.run("deploy-release.sh", [candidateSha], { FAIL_RESTIC_CHECK: "1" }))
      .rejects.toMatchObject({ code: 1 });
    const raw = await release.events();
    expect(raw.filter((line) => line.startsWith("systemctl stop") || line.startsWith("systemctl restart"))).toEqual([]);
    expect(await readFile(release.databasePath, "utf8")).toBe("old-data\n");
    expect(await readlink(join(release.connectorsRoot, "current"))).toBe(release.oldRuntime);
    expect((await readFile(release.systemdState, "utf8")).trim()).toBe("enabled active");
    expect(await release.stagingLeftovers()).toEqual([]);
  });

  it("keeps the migrated database when web rollout fails after candidate readiness", async () => {
    const release = await fixture();
    await expect(release.run("deploy-release.sh", [candidateSha], { FAIL_COMPOSE_UP: "1" }))
      .rejects.toMatchObject({ code: 1 });
    const raw = await release.events();
    expect(raw.some((line) => line.startsWith("restore-adapter"))).toBe(false);
    expect(await readFile(release.databasePath, "utf8")).toBe("old-data\ncandidate-migrated\n");
    expect(await readlink(join(release.connectorsRoot, "current"))).toBe(release.oldRuntime);
    expect(await release.stagingLeftovers()).toEqual([]);
  });

  it("first installation skips backup and restore metadata and lets the candidate create the database", async () => {
    const release = await fixture({ previousRuntime: false, database: false });
    await release.run("deploy-release.sh", [candidateSha]);
    const raw = await release.events();
    expect(raw.filter((line) => /^(systemd-run|restic|backup-adapter|restore-adapter)/u.test(line))).toEqual([]);
    const manifest = JSON.parse(await readFile(join(release.candidateRelease, "release-manifest.json"), "utf8"));
    expect(manifest.connectors.preActivationSnapshot).toBeNull();
    expect(await readFile(release.databasePath, "utf8")).toBe("candidate-migrated\n");
  });

  it.each([
    { previousRuntime: true, database: false },
    { previousRuntime: false, database: true },
  ])("refuses an inconsistent host before writes ($previousRuntime runtime, $database database)", async (state) => {
    const release = await fixture(state);
    await expect(release.run("deploy-release.sh", [candidateSha]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("inconsistent") });
    expect(await exists(join(release.root, "config/releases", `${candidateSha}.compose.env`))).toBe(false);
    expect((await release.events()).filter((line) => line.startsWith("docker build"))).toEqual([]);
  });

  it("refuses an upgrade when the active runtime has no backup adapter", async () => {
    const release = await fixture({ adapters: false });
    await expect(release.run("deploy-release.sh", [candidateSha]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("backup adapter") });
    expect((await release.events()).filter((line) => line.startsWith("docker build"))).toEqual([]);
  });

  it("lets exactly one of two concurrent deployments cross the deployment lock", async () => {
    const release = await fixture();
    const started = join(release.root, "build.started");
    const unblock = join(release.root, "build.unblock");
    const first = spawn("sh", [join(operationsRoot, "deploy-release.sh"), candidateSha], {
      env: release.environment({ BUILD_STARTED_FILE: started, BUILD_BLOCK_FILE: unblock }),
      stdio: "ignore",
    });
    const firstExit = new Promise<number | null>((resolve) => first.once("exit", resolve));
    for (let attempt = 0; attempt < 200 && !(await exists(started)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await exists(started)).toBe(true);
    const second = await release.run("deploy-release.sh", [candidateSha])
      .catch((error: { code: number; stderr: string }) => error);
    await writeFile(unblock, "");
    expect(second).toMatchObject({ code: 75, stderr: expect.stringContaining("deployment or rollback is already running") });
    expect(await firstExit).toBe(0);
    expect((await release.events()).filter((line) => line.startsWith("backup-adapter"))).toHaveLength(1);
  });
});

/** Active release = candidate, deployed over the old release with a recorded pre-activation snapshot. */
const deployedRelease = async (): Promise<ReleaseFixture> => {
  const release = await fixture();
  await release.run("deploy-release.sh", [candidateSha]);
  await writeFile(release.databasePath, "old-data\ncandidate-migrated\nnew-writes\n");
  await rm(join(release.root, "events.log"));
  return release;
};

describe("connectors rollback", () => {
  it("default rollback switches runtime but preserves the current database", async () => {
    const release = await deployedRelease();
    const result = await release.run("rollback-release.sh", [oldSha]);
    expect(result.stdout).toContain("Database state was not changed");
    const raw = await release.events();
    expect(raw.filter((line) => /^(restic|restore-adapter|backup-adapter)/u.test(line))).toEqual([]);
    expect(await readFile(release.databasePath, "utf8")).toBe("old-data\ncandidate-migrated\nnew-writes\n");
    expect(await readlink(join(release.connectorsRoot, "current"))).toBe(release.oldRuntime);
  });

  it("default rollback restores the current runtime and exits nonzero when the target is not ready", async () => {
    const release = await deployedRelease();
    await rm(join(release.root, "readiness.count"));
    await expect(release.run("rollback-release.sh", [oldSha], { READINESS_FAIL_AT: "1" }))
      .rejects.toMatchObject({ code: 1 });
    expect(await readlink(join(release.connectorsRoot, "current"))).toBe(release.candidateRuntime);
    // The restarted current runtime appends its fake startup marker to the preserved database.
    expect(await readFile(release.databasePath, "utf8")).toMatch(/^old-data\ncandidate-migrated\nnew-writes\n/u);
    expect((await release.events()).filter((line) => line.startsWith("restic"))).toEqual([]);
  });

  it("restores the recorded Restic snapshot only with the exact flag, quarantining current data", async () => {
    const release = await deployedRelease();
    const result = await release.run("rollback-release.sh", ["--restore-connectors-snapshot", oldSha]);
    expect(result.stderr).toContain("WARNING");
    const manifest = JSON.parse(await readFile(join(release.candidateRelease, "release-manifest.json"), "utf8"));
    const raw = await release.events();
    expect(raw.find((line) => line.startsWith("restic restore"))).toContain(manifest.connectors.preActivationSnapshot.resticSnapshotId);
    const stop = raw.findIndex((line) => line.startsWith("systemctl stop"));
    const restores = raw.flatMap((line, index) => (line.startsWith("restore-adapter") ? [index] : []));
    expect(restores).toHaveLength(2);
    expect(restores[0]).toBeLessThan(stop);
    expect(restores[1]).toBeGreaterThan(stop);
    expect(raw[restores[1]!]).toBe(`restore-adapter ${oldSha} ${release.databasePath}`);
    expect(await readFile(release.databasePath, "utf8")).toBe("old-data\n");
    const quarantined = (await import("node:fs/promises")).readdir(join(release.root, "var/pih-connectors"));
    const names = await quarantined;
    const quarantine = names.find((name) => name.startsWith(`connectors.sqlite.pre-rollback-${candidateSha}-`));
    expect(quarantine).toBeDefined();
    expect(await readFile(join(release.root, "var/pih-connectors", quarantine!), "utf8")).toContain("new-writes");
    expect(await readlink(join(release.connectorsRoot, "current"))).toBe(release.oldRuntime);
    expect(await release.stagingLeftovers()).toEqual([]);
  });

  it("puts the current database back when the snapshot rollback target is not ready", async () => {
    const release = await deployedRelease();
    await rm(join(release.root, "readiness.count"));
    await expect(release.run("rollback-release.sh", ["--restore-connectors-snapshot", oldSha], { READINESS_FAIL_AT: "1" }))
      .rejects.toMatchObject({ code: 1 });
    expect(await readFile(release.databasePath, "utf8")).toMatch(/^old-data\ncandidate-migrated\nnew-writes\n/u);
    expect(await readlink(join(release.connectorsRoot, "current"))).toBe(release.candidateRuntime);
    expect((await readFile(release.systemdState, "utf8")).trim()).toBe("enabled active");
    expect(await release.stagingLeftovers()).toEqual([]);
  });

  it.each([
    ["a misspelled flag", ["--restore-connector-snapshot", oldSha], 64, "Usage"],
    ["a rollback to the current release", ["--restore-connectors-snapshot", candidateSha], 1, "current release"],
    ["an unknown target", ["--restore-connectors-snapshot", "e".repeat(40)], 1, "Rollback input is missing"],
  ])("refuses %s before stopping any service", async (_name, args, code, message) => {
    const release = await deployedRelease();
    await expect(release.run("rollback-release.sh", args))
      .rejects.toMatchObject({ code, stderr: expect.stringContaining(message) });
    expect((await release.events()).filter((line) => /^(systemctl (stop|restart)|restic restore)/u.test(line))).toEqual([]);
    expect(await readFile(release.databasePath, "utf8")).toContain("new-writes");
  });

  it.each([
    ["missing", (connectors: Record<string, unknown>) => { connectors.preActivationSnapshot = null; }, "no recorded"],
    ["mismatched", (connectors: Record<string, unknown>) => {
      connectors.preActivationSnapshot = {
        ...(connectors.preActivationSnapshot as Record<string, string>),
        manifestSha256: "0".repeat(64),
      };
    }, "checksum"],
  ])("refuses %s snapshot metadata before stopping any service", async (_name, mutate, message) => {
    const release = await deployedRelease();
    const manifestPath = join(release.candidateRelease, "release-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    mutate(manifest.connectors);
    await rm(manifestPath);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(release.run("rollback-release.sh", ["--restore-connectors-snapshot", oldSha]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
    expect((await release.events()).filter((line) => /^systemctl (stop|restart)/u.test(line))).toEqual([]);
    expect(await readFile(release.databasePath, "utf8")).toContain("new-writes");
    expect(await release.stagingLeftovers()).toEqual([]);
  });
});

describe("backup.sh connectors snapshot input", () => {
  const prepare = async () => {
    const release = await fixture();
    const stagingRoot = join(release.root, "backups/connectors-staging");
    const snapshot = join(stagingRoot, "deploy.fixture/snapshot");
    await mkdir(snapshot, { recursive: true, mode: 0o700 });
    await chmod(snapshot, 0o700);
    await writeFile(join(snapshot, "connectors.sqlite"), "old-data\n");
    const sha = createHash("sha256").update("old-data\n").digest("hex");
    await writeFile(join(snapshot, "manifest.json"), JSON.stringify({ databaseSha256: sha }));
    const run = (args: readonly string[]) => release.run("backup.sh", args, {
      RESTIC_REPOSITORY: release.resticRepository,
    });
    return { release, stagingRoot, snapshot, run };
  };
  const tag = `pre-activation-${candidateSha}`;

  it("archives a valid pair with the context tag and reports exactly one snapshot ID", async () => {
    const { release, snapshot, run } = await prepare();
    const result = await run(["--connectors-snapshot", snapshot, "--context-tag", tag]);
    expect(result.stdout).toMatch(/^connectors-snapshot-id=[0-9a-f]{64}$/mu);
    expect(await release.stagingLeftovers()).toEqual(["connectors-staging/deploy.fixture"]);
  });

  it("groups connector snapshots by a stable tag so retention prunes them without regrouping other snapshots", async () => {
    const { release, snapshot, run } = await prepare();
    await run(["--connectors-snapshot", snapshot, "--context-tag", tag]);
    const raw = await release.events();
    const backup = raw.find((line) => line.startsWith("restic backup "));
    expect(backup).toContain("--tag pih-connectors-pre-activation");
    const forgets = raw.filter((line) => line.startsWith("restic forget "));
    expect(forgets).toEqual([
      "restic forget --tag personal-intelligence-hub --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune",
      "restic forget --tag pih-connectors-pre-activation --group-by host --keep-last 5 --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune",
    ]);
    expect(raw.findIndex((line) => line.startsWith("restic check")))
      .toBeGreaterThan(raw.lastIndexOf(forgets[1]!));
  });

  it("leaves ordinary backups ungrouped and untagged as connector snapshots", async () => {
    const { release } = await prepare();
    await release.run("backup.sh", [], { RESTIC_REPOSITORY: release.resticRepository });
    const raw = await release.events();
    expect(raw.find((line) => line.startsWith("restic backup "))).not.toContain("pih-connectors-pre-activation");
    // The connector retention pass only ever selects snapshots carrying the connector tag.
    expect(raw.filter((line) => line.startsWith("restic forget ") && !line.includes("--tag pih-connectors-pre-activation")))
      .toEqual(["restic forget --tag personal-intelligence-hub --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune"]);
  });

  it.each([
    ["an unpaired snapshot argument", (s: string) => ["--connectors-snapshot", s], 64],
    ["a malformed context tag", (s: string) => ["--connectors-snapshot", s, "--context-tag", "pre-activation-main"], 64],
    ["an unknown argument", () => ["--everything"], 64],
  ])("rejects %s", async (_name, args, code) => {
    const { release, snapshot, run } = await prepare();
    await expect(run(args(snapshot))).rejects.toMatchObject({ code });
    expect((await release.events()).filter((line) => line.startsWith("restic backup"))).toEqual([]);
  });

  it.each([
    ["outside the staging root", async (p: Awaited<ReturnType<typeof prepare>>) => {
      const outside = join(p.release.root, "outside");
      await mkdir(outside, { mode: 0o700 });
      return outside;
    }, "below the connectors staging root"],
    ["a symbolic link", async (p: Awaited<ReturnType<typeof prepare>>) => {
      const link = join(p.stagingRoot, "deploy.fixture/link");
      await symlink(p.snapshot, link);
      return link;
    }, "without symbolic links"],
    ["a directory with an extra file", async (p: Awaited<ReturnType<typeof prepare>>) => {
      await writeFile(join(p.snapshot, "extra.txt"), "x");
      return p.snapshot;
    }, "exactly the database and manifest"],
    ["a database that does not match its manifest", async (p: Awaited<ReturnType<typeof prepare>>) => {
      await writeFile(join(p.snapshot, "connectors.sqlite"), "tampered\n");
      return p.snapshot;
    }, "does not match its manifest"],
    ["a group-readable directory", async (p: Awaited<ReturnType<typeof prepare>>) => {
      await chmod(p.snapshot, 0o750);
      return p.snapshot;
    }, "mode 0700"],
  ])("rejects a snapshot that is %s before any Restic write", async (_name, select, message) => {
    const prepared = await prepare();
    const path = await select(prepared);
    await expect(prepared.run(["--connectors-snapshot", path, "--context-tag", tag]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
    expect((await prepared.release.events()).filter((line) => line.startsWith("restic backup"))).toEqual([]);
    expect((await prepared.release.stagingLeftovers()).filter((entry) => entry.startsWith("staging."))).toEqual([]);
  });
});
