import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { assertDeployBaseline, assertRollbackBaseline } from "./check-connectors-migration-baseline.mjs";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const operationsRoot = `${repositoryRoot}/infrastructure/operations`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("host operation scripts", () => {
  const scripts = [
    "backup.sh",
    "compose-current.sh",
    "deploy-release.sh",
    "restic-lock-guard.sh",
    "restore-rehearsal.sh",
    "rollback-release.sh",
    "send-alert.sh",
  ];

  it.each(scripts)("keeps %s valid POSIX shell", async (script) => {
    await expect(
      exec("sh", ["-n", `${operationsRoot}/${script}`]),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("preserves the backup and rollback safety invariants", async () => {
    const [backup, restore, deploy, rollback, lockGuard] = await Promise.all([
      readFile(`${operationsRoot}/backup.sh`, "utf8"),
      readFile(`${operationsRoot}/restore-rehearsal.sh`, "utf8"),
      readFile(`${operationsRoot}/deploy-release.sh`, "utf8"),
      readFile(`${operationsRoot}/rollback-release.sh`, "utf8"),
      readFile(`${operationsRoot}/restic-lock-guard.sh`, "utf8"),
    ]);

    expect(backup).toContain("flock -n");
    expect(backup).toContain("pg_dump");
    expect(backup).toContain("pg_restore --list");
    expect(backup).toContain("restic forget");
    expect(restore).toContain("pih-restore-");
    expect(restore).toContain("down --volumes");
    expect(deploy).toContain("pih-api:$release_sha");
    expect(deploy).toContain("pih-web:$release_sha");
    expect(rollback).not.toContain("pg_restore");
    expect(lockGuard).not.toContain("--remove-all");
  });

  it("audits every production image before any rollout and pins PostgreSQL by image ID", async () => {
    const deploy = await readFile(`${operationsRoot}/deploy-release.sh`, "utf8");
    const rollout = deploy.indexOf("up --detach --wait --remove-orphans", deploy.indexOf("image_inspect_temporary="));
    for (const image of ["api", "web", "postgres"]) {
      expect(deploy).toContain(`infrastructure/docker/${image}.Dockerfile`);
      expect(deploy).toContain(`sbom-${image}.cyclonedx.json`);
      const audit = deploy.indexOf(`grype "pih-${image}:$release_sha" --fail-on high`);
      expect(audit).toBeGreaterThan(0);
      expect(audit).toBeLessThan(rollout);
    }
    expect(deploy).toContain("PIH_POSTGRES_IMAGE=%s");
    expect(deploy).toContain("--format '{{.Id}}'");
    expect(deploy).toContain('"pih-postgres:$release_sha" \\');
  });

  it("keeps systemd startup, failure alerting, and host confinement explicit", async () => {
    const [application, backup, connectors] = await Promise.all([
      readFile(
        `${repositoryRoot}/infrastructure/systemd/personal-intelligence-hub.service`,
        "utf8",
      ),
      readFile(
        `${repositoryRoot}/infrastructure/systemd/personal-intelligence-hub-backup.service`,
        "utf8",
      ),
      readFile(
        `${repositoryRoot}/infrastructure/systemd/personal-intelligence-hub-connectors.service`,
        "utf8",
      ),
    ]);

    expect(application).toContain("After=network-online.target docker.service tailscaled.service");
    expect(application).toContain("NoNewPrivileges=true");
    expect(application).toContain("ProtectSystem=strict");
    expect(backup).toContain("OnFailure=personal-intelligence-hub-alert@%n.service");
    expect(connectors).toContain("RuntimeDirectoryPreserve=yes");
    expect(backup).toContain("EnvironmentFile=/srv/personal-intelligence-hub/secrets/restic.env");
  });
});

describe("immutable release deployment", () => {
  it.each(["metadata", "image"])("rejects a reused SHA with existing %s before writes or builds", async (existing) => {
    const root = await mkdtemp(join(tmpdir(), "pih-deploy-reuse-"));
    temporaryDirectories.push(root);
    const sha = "a".repeat(40);
    const release = join(root, "releases", sha);
    const bin = join(root, "bin");
    await mkdir(join(release, "infrastructure", "docker"), { recursive: true });
    await mkdir(join(root, "config", "releases"), { recursive: true });
    await mkdir(bin);
    await writeFile(join(release, "infrastructure", "docker", "compose.production.yaml"), "services: {}\n");
    await writeFile(join(root, "config", "compose.env"), "POSTGRES_DB=fixture\n");
    const environment = join(root, "config", "releases", `${sha}.compose.env`);
    const original = "PIH_API_IMAGE=sha256:fixture-api\nPIH_WEB_IMAGE=sha256:fixture-web\nPIH_POSTGRES_IMAGE=sha256:fixture-postgres\n";
    if (existing === "metadata") await writeFile(environment, original);
    await symlink(release, join(root, "current"));
    for (const command of ["jq", "curl", "syft", "grype"]) {
      await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    const log = join(root, "docker.log");
    await writeFile(join(bin, "docker"), `#!/bin/sh
if [ "$1 $2" = "image inspect" ]; then
  [ "$EXISTING_IMAGE" = "yes" ] && exit 0
  exit 1
fi
printf '%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
exit 42
`, { mode: 0o700 });
    await expect(exec("sh", [`${operationsRoot}/deploy-release.sh`, sha], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PIH_ROOT: root, EXISTING_IMAGE: existing === "image" ? "yes" : "no", DEPLOY_TEST_LOG: log },
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("already exists") });
    if (existing === "metadata") await expect(readFile(environment, "utf8")).resolves.toBe(original);
    else await expect(readFile(environment, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("connectors atomic release", () => {
  it("builds, scans, extracts, verifies, and activates connectors before web rollout", async () => {
    const deploy = await readFile(`${operationsRoot}/deploy-release.sh`, "utf8");
    const rollback = await readFile(`${operationsRoot}/rollback-release.sh`, "utf8");
    expect(deploy).toContain('pih-connectors-export:$release_sha');
    expect(deploy).toContain('sbom-connectors.cyclonedx.json');
    expect(deploy).toContain('grype "pih-connectors-export:$release_sha" --fail-on high');
    expect(deploy).toContain('docker create --name "pih-connectors-export-$release_sha-$$" "pih-connectors-export:$release_sha" /__export_only__');
    expect(deploy).toContain('docker cp "$connectors_container:/opt/connectors/."');
    expect(deploy).toContain("connectors: {exportImage: $connectorsImage");
    expect(deploy).toContain('sha256sum');
    expect(deploy).toContain('systemctl restart "$connectors_service"');
    expect(deploy).toContain('check-connectors-readiness.mjs');
    expect(deploy).toContain('previousReleaseSha');
    expect(deploy).toContain('previousConnectorsRuntime');
    expect(deploy).toContain('previousConnectorsEnabled');
    expect(deploy).toContain('previousConnectorsActive');
    expect(deploy).toContain('check-connectors-migration-baseline.mjs');
    expect(rollback).toContain('check-connectors-migration-baseline.mjs');
    expect(deploy).toContain('CONNECTORS_DEPLOYER_ENV_FILE');
    expect(deploy).toContain('flock -n 9');
    expect(rollback).toContain('systemctl restart "$connectors_service"');
    expect(rollback).toContain('check-connectors-readiness.mjs');
    expect(rollback).toContain('flock -n 9');
    expect(rollback).toContain("target_connectors_enabled=$(jq -er '.connectors.enabled'");
    expect(rollback).toContain("target_connectors_active=$(jq -er '.connectors.active'");
    expect(deploy.indexOf('restore_connectors_state || echo')).toBeLessThan(deploy.indexOf('restoring previous application images'));
    expect(rollback.indexOf('restore_connectors_state || echo')).toBeLessThan(rollback.indexOf('docker compose --project-name "$compose_project" --env-file "$previous_environment"'));

    const restart = deploy.indexOf('systemctl restart "$connectors_service"');
    const readiness = deploy.indexOf('check-connectors-readiness.mjs', restart);
    const webRollout = deploy.indexOf('up --detach --wait --remove-orphans', deploy.indexOf('image_inspect_temporary='));
    expect(restart).toBeGreaterThan(-1);
    expect(readiness).toBeGreaterThan(restart);
    expect(webRollout).toBeGreaterThan(readiness);
  });

  it("serializes deploy and rollback on the same lock for their full transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "pih-deploy-lock-"));
    temporaryDirectories.push(root);
    const lock = join(root, ".deployment.lock");
    const holder = spawn("flock", ["-n", lock, "sleep", "10"], { stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => holder.once("exit", (code) => resolve(code)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(holder.exitCode).toBeNull();

    try {
      for (const script of ["deploy-release.sh", "rollback-release.sh"]) {
        await expect(exec("sh", [`${operationsRoot}/${script}`, "b".repeat(40)], {
          env: { ...process.env, PIH_ROOT: root },
        })).rejects.toMatchObject({ code: 75, stderr: expect.stringContaining("deployment or rollback") });
      }
    } finally {
      holder.kill("SIGTERM");
      await exited;
    }
  });
});

describe("connector migration rollback baseline policy", () => {
  it("requires history-aware active baselines before provider migrations", async () => {
    expect(() => assertDeployBaseline(
      ["0000_foundation", "0001_provider"],
      { gitSha: "3d4a4d3", connectors: {} },
    )).toThrow("history-compatible active baseline");
    expect(() => assertDeployBaseline(
      ["0000_foundation", "0001_provider"],
      { gitSha: "a".repeat(40), connectors: {
        migrationHistoryFormatVersion: 1,
        migrations: ["0000_foundation"],
      } },
    )).not.toThrow();
  });

  it("allows first provider activation when no legacy connectors process is running", () => {
    expect(() => assertDeployBaseline(
      ["0000_foundation", "0001_provider"],
      null,
      "inactive",
    )).not.toThrow();
    expect(() => assertDeployBaseline(
      ["0000_foundation", "0001_provider"],
      null,
      "active",
    )).toThrow("history-compatible active baseline");
  });

  it("rejects rollback to a runtime older than the applied provider suffix", async () => {
    const active = { gitSha: "b".repeat(40), connectors: {
      migrationHistoryFormatVersion: 1,
      migrations: ["0000_foundation", "0001_provider"],
    } };
    expect(() => assertRollbackBaseline(active, {
      gitSha: "3d4a4d3", connectors: {},
    })).toThrow("history-compatible active rollback target");
    expect(() => assertRollbackBaseline(active, {
      gitSha: "3d4a4d3", connectors: {},
    }, "inactive")).not.toThrow();
    expect(() => assertRollbackBaseline(active, {
      gitSha: "a".repeat(40), connectors: {
        migrationHistoryFormatVersion: 1,
        migrations: ["0000_foundation"],
      },
    })).not.toThrow();
  });

  it("fails closed when active release migration metadata is missing and target would run", () => {
    expect(() => assertRollbackBaseline(
      { gitSha: "b".repeat(40), connectors: {} },
      { gitSha: "c".repeat(40), connectors: {} },
      "active",
    )).toThrow("missing migration-history metadata");
    expect(() => assertRollbackBaseline(
      { gitSha: "b".repeat(40), connectors: {} },
      { gitSha: "c".repeat(40), connectors: {} },
      "inactive",
    )).not.toThrow();
  });

  it("applies the active-versus-inactive rule through the release helper CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "pih-migration-baseline-cli-"));
    temporaryDirectories.push(root);
    const candidate = join(root, "candidate.txt");
    const active = join(root, "active.json");
    await writeFile(candidate, "0000_foundation.sql\n0001_provider.sql\n");
    await writeFile(active, JSON.stringify({ gitSha: "3d4a4d3", connectors: {} }));
    const helper = join(operationsRoot, "check-connectors-migration-baseline.mjs");
    await expect(exec(process.execPath, [helper, "deploy", candidate, active, "active"]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("history-compatible active baseline") });
    await expect(exec(process.execPath, [helper, "deploy", candidate, active, "inactive"]))
      .resolves.toBeDefined();
  });

  it("does not accept a migration list that is not an exact lexical prefix", async () => {
    expect(() => assertDeployBaseline(
      ["0000_foundation", "0001_provider"],
      { gitSha: "a".repeat(40), connectors: {
        migrationHistoryFormatVersion: 1,
        migrations: ["0000_foundation", "0002_other"],
      } },
    )).toThrow("migration prefix");
  });
});

describe("connectors recovery", () => {
  it.each([
    { previous: "enabled active", expectedReadinessChecks: "2", hasPreviousRuntime: true, failRestoreLink: false, failPointerUpdate: false },
    { previous: "disabled inactive", expectedReadinessChecks: "1", hasPreviousRuntime: false, hasProviderMigrations: true, failRestoreLink: false, failPointerUpdate: false },
    { previous: "enabled active", expectedReadinessChecks: "1", hasPreviousRuntime: true, failRestoreLink: true, failPointerUpdate: false },
    { previous: "enabled active", expectedReadinessChecks: "2", hasPreviousRuntime: true, failRestoreLink: false, failPointerUpdate: true },
  ])("restores connector symlink and exact systemd state without touching web when readiness fails ($previous)", async ({ previous, expectedReadinessChecks, hasPreviousRuntime, hasProviderMigrations = false, failRestoreLink, failPointerUpdate }) => {
    const root = await mkdtemp(join(tmpdir(), "pih-connectors-deploy-failure-"));
    temporaryDirectories.push(root);
    const sha = "c".repeat(40);
    const oldSha = "d".repeat(40);
    const release = join(root, "releases", sha);
    const oldRelease = join(root, "releases", oldSha);
    const connectorsRoot = join(root, "host-connectors");
    const runtime = join(connectorsRoot, "releases", sha);
    const previousRuntime = join(connectorsRoot, "releases", oldSha);
    const bin = join(root, "bin");
    const migrationDirectory = join(release, "apps/connectors/src/migrations");
    const deployerEnvironment = join(root, "secrets/connectors-deployer.env");
    const systemdState = join(root, "systemd.state");
    const readinessCount = join(root, "readiness.count");
    const dockerLog = join(root, "docker.log");
    const systemdLog = join(root, "systemd.log");
    const jq = (await exec("sh", ["-c", "command -v jq"])).stdout.trim();

    await mkdir(migrationDirectory, { recursive: true });
    await mkdir(join(release, "infrastructure/docker"), { recursive: true });
    await mkdir(join(release, "infrastructure/operations"), { recursive: true });
    await writeFile(join(release, "infrastructure/operations/check-connectors-readiness.mjs"), "export {};\n");
    await writeFile(join(release, "infrastructure/operations/check-connectors-migration-baseline.mjs"), "export {};\n");
    await mkdir(join(oldRelease, "infrastructure/docker"), { recursive: true });
    await mkdir(join(root, "config/releases"), { recursive: true });
    await mkdir(join(root, "secrets"), { recursive: true });
    await mkdir(join(connectorsRoot, "releases"), { recursive: true });
    await mkdir(previousRuntime, { recursive: true });
    await mkdir(bin);
    await writeFile(join(release, "REVISION"), `${sha}\n`);
    await writeFile(join(release, "infrastructure/docker/compose.production.yaml"), "services: {}\n");
    for (const name of ["api", "web", "postgres"]) {
      await writeFile(join(release, `infrastructure/docker/${name}.Dockerfile`), "FROM scratch\n");
    }
    await writeFile(join(release, "infrastructure/docker/connectors-build.Dockerfile"), "FROM scratch\n");
    await writeFile(join(migrationDirectory, "0000_foundation.sql"), "CREATE TABLE fixture(id TEXT);\n");
    if (hasProviderMigrations) {
      await writeFile(join(migrationDirectory, "0001_provider.sql"), "CREATE TABLE provider_fixture(id TEXT);\n");
    }
    await writeFile(join(oldRelease, "infrastructure/docker/compose.production.yaml"), "services: {}\n");
    const oldEnvironment = join(root, "config/releases", `${oldSha}.compose.env`);
    await writeFile(oldEnvironment, "PIH_WEB_PORT=3000\n");
    await symlink(oldRelease, join(root, "current"));
    await symlink(oldEnvironment, join(root, "config/current-compose.env"));
    if (hasPreviousRuntime) await symlink(previousRuntime, join(connectorsRoot, "current"));
    await writeFile(join(root, "config/compose.env"), "POSTGRES_DB=fixture\nPIH_WEB_PORT=3000\n");
    await writeFile(deployerEnvironment, [
      "CONNECTORS_DEPLOYER_SERVICE_TOKEN=fictional-deployer-token-32-bytes-minimum",
      "CONNECTORS_DEPLOYER_ISSUER=pih-deployer",
      `CONNECTORS_DEPLOYER_SIGNING_KEY=${Buffer.alloc(32, 7).toString("base64url")}`,
      "CONNECTORS_DEPLOYER_ACTOR_ID=service:pih-deployer",
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(systemdState, `${previous}\n`);
    await symlink(jq, join(bin, "jq"));

    const commands: Record<string, string> = {
      docker: `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  if [ "\${3:-}" = "--format" ]; then printf 'sha256:fixture-image-id\\n'; exit 0; fi
  if [ "$#" -eq 3 ]; then exit 1; fi
  printf '[]\\n'; exit 0
fi
case "$1" in
  build) exit 0 ;;
  create) printf 'connector-export-container\\n' ;;
  cp)
    mkdir -p "$3/dist/src/migrations"
    cp "$TEST_MIGRATIONS"/*.sql "$3/dist/src/migrations/"
    : > "$3/dist/src/main.js"
    ;;
  rm) exit 0 ;;
  compose) case " $* " in *" config "*) exit 0 ;; *" up "*) exit 0 ;; esac ;;
esac
exit 0
`,
      syft: `#!/bin/sh
for argument do case "$argument" in cyclonedx-json=*) : > "\${argument#*=}" ;; esac; done
`,
      grype: "#!/bin/sh\nexit 0\n",
      curl: "#!/bin/sh\nexit 0\n",
      node: `#!/bin/sh
case "$1" in *check-connectors-migration-baseline.mjs) exit 0 ;; esac
count=0
[ ! -f "$READINESS_COUNT" ] || count=$(cat "$READINESS_COUNT")
count=$((count + 1))
printf '%s\\n' "$count" > "$READINESS_COUNT"
[ "\${READINESS_FAIL_FIRST:-1}" != 1 ] || [ "$count" -ne 1 ]
`,
      systemctl: `#!/bin/sh
set -eu
action=$1
printf '%s\n' "$*" >> "$SYSTEMD_LOG"
printf 'systemctl %s\n' "$*" >> "$EVENT_LOG"
set -- $(cat "$SYSTEMD_STATE")
enabled=$1
active=$2
case "$action" in
  is-enabled) printf '%s\n' "$enabled"; [ "$enabled" = enabled ] ;;
  is-active) printf '%s\n' "$active"; [ "$active" = active ] ;;
  enable) enabled=enabled ;;
  disable) enabled=disabled ;;
  restart|start) active=active ;;
  stop) active=inactive ;;
  *) exit 1 ;;
esac
case "$action" in is-enabled|is-active) ;; *) printf '%s %s\n' "$enabled" "$active" > "$SYSTEMD_STATE" ;; esac
`,
      chown: "#!/bin/sh\nexit 0\n",
      chmod: "#!/bin/sh\nexit 0\n",
      mv: `#!/bin/sh
case "$*" in
  *".current-restore."*) [ "\${RESTORE_LINK_FAILURE:-0}" != 1 ] || exit 1 ;;
  *".current-compose."*"/current-compose.env")
    if [ "\${APP_POINTER_FAILURE:-0}" = 1 ]; then
      printf 'Injected app pointer failure\n' >&2
      exit 1
    fi
    ;;
esac
exec /usr/bin/mv "$@"
`,
      stat: `#!/bin/sh
if [ "$1" = "-c" ]; then printf '0:600\\n'; else exec /usr/bin/stat "$@"; fi
`,
    };
    for (const [name, contents] of Object.entries(commands)) {
      await writeFile(join(bin, name), contents, { mode: 0o700 });
    }

    await expect(exec("sh", [`${operationsRoot}/deploy-release.sh`, sha], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PIH_ROOT: root,
        PIH_CONNECTORS_ROOT: connectorsRoot,
        CONNECTORS_DEPLOYER_ENV_FILE: deployerEnvironment,
        DOCKER_LOG: dockerLog,
        SYSTEMD_LOG: systemdLog,
        SYSTEMD_STATE: systemdState,
        EVENT_LOG: join(root, "events.log"),
        READINESS_COUNT: readinessCount,
        TEST_MIGRATIONS: migrationDirectory,
        RESTORE_LINK_FAILURE: failRestoreLink ? "1" : "0",
        APP_POINTER_FAILURE: failPointerUpdate ? "1" : "0",
        READINESS_FAIL_FIRST: failPointerUpdate ? "0" : "1",
      },
    })).rejects.toMatchObject({
      code: 1,
      stderr: failRestoreLink
        ? expect.stringContaining("Previous connectors service restore failed")
        : failPointerUpdate
          ? expect.stringContaining("Injected app pointer failure")
          : expect.stringContaining("readiness"),
    });

    if (failRestoreLink) {
      expect(await readlink(join(connectorsRoot, "current"))).toBe(runtime);
    } else if (hasPreviousRuntime) {
      expect(await readlink(join(connectorsRoot, "current"))).toBe(previousRuntime);
    } else {
      await expect(readlink(join(connectorsRoot, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readlink(join(root, "current"))).toBe(oldRelease);
    expect(await readlink(join(root, "config/current-compose.env"))).toBe(oldEnvironment);
    expect((await readFile(systemdState, "utf8")).trim()).toBe(
      failRestoreLink ? "enabled inactive" : previous,
    );
    expect((await readFile(readinessCount, "utf8")).trim()).toBe(expectedReadinessChecks);
    const dockerCalls = await readFile(dockerLog, "utf8");
    if (failPointerUpdate) {
      expect(dockerCalls.match(/compose .* up /gu)).toHaveLength(2);
    } else {
      expect(dockerCalls).not.toMatch(/compose .* up /u);
    }
    const systemdCalls = await readFile(systemdLog, "utf8");
    expect(systemdCalls).toContain("restart personal-intelligence-hub-connectors.service");
    expect(systemdCalls).toContain("enable personal-intelligence-hub-connectors.service");
  });
});

  it("rejects a connectors-aware release manifest paired with another release runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "pih-cross-release-rollback-"));
    temporaryDirectories.push(root);
    const targetSha = "a".repeat(40);
    const activeSha = "b".repeat(40);
    const wrongSha = "c".repeat(40);
    const targetRelease = join(root, "releases", targetSha);
    const activeRelease = join(root, "releases", activeSha);
    const wrongRuntime = join(root, "host-connectors/releases", wrongSha);
    await mkdir(join(targetRelease, "infrastructure/docker"), { recursive: true });
    await mkdir(join(activeRelease, "infrastructure/docker"), { recursive: true });
    await mkdir(join(wrongRuntime, "dist/src/migrations"), { recursive: true });
    await mkdir(join(root, "config/releases"), { recursive: true });
    await writeFile(join(targetRelease, "infrastructure/docker/compose.production.yaml"), "services: {}\n");
    await writeFile(join(targetRelease, "release-manifest.json"), JSON.stringify({
      gitSha: targetSha,
      connectors: {
        runtimeDirectory: wrongRuntime,
        enabled: "enabled",
        active: "active",
      },
    }));
    await writeFile(join(root, "config/releases", `${targetSha}.compose.env`), "PIH_WEB_PORT=3000\n");
    await writeFile(join(activeRelease, "release-manifest.json"), JSON.stringify({ gitSha: activeSha }));
    await symlink(activeRelease, join(root, "current"));

    await expect(exec("sh", [`${operationsRoot}/rollback-release.sh`, targetSha], {
      env: { ...process.env, PIH_ROOT: root, PIH_CONNECTORS_ROOT: join(root, "host-connectors") },
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("does not match the requested release"),
    });
  });

  it("rejects a legacy release older than the active connectors release predecessor", async () => {
    const root = await mkdtemp(join(tmpdir(), "pih-legacy-rollback-mismatch-"));
    temporaryDirectories.push(root);
    const targetSha = "a".repeat(40);
    const predecessorSha = "b".repeat(40);
    const activeSha = "c".repeat(40);
    const targetRelease = join(root, "releases", targetSha);
    const activeRelease = join(root, "releases", activeSha);
    const bin = join(root, "bin");
    await mkdir(join(targetRelease, "infrastructure/docker"), { recursive: true });
    await mkdir(join(activeRelease, "infrastructure/docker"), { recursive: true });
    await mkdir(join(root, "config/releases"), { recursive: true });
    await mkdir(bin);
    await writeFile(join(targetRelease, "infrastructure/docker/compose.production.yaml"), "services: {}\n");
    await writeFile(join(targetRelease, "release-manifest.json"), JSON.stringify({ gitSha: targetSha, images: [] }));
    await writeFile(join(activeRelease, "release-manifest.json"), JSON.stringify({
      gitSha: activeSha,
      connectors: {
        runtimeDirectory: join(root, "host-connectors/releases", activeSha),
        previousReleaseSha: predecessorSha,
        previousConnectorsRuntime: join(root, "host-connectors/releases", predecessorSha),
        previousConnectorsEnabled: "enabled",
        previousConnectorsActive: "active",
        enabled: "enabled",
        active: "active",
      },
    }));
    await writeFile(join(root, "config/releases", `${targetSha}.compose.env`), "PIH_WEB_PORT=3000\n");
    await symlink(activeRelease, join(root, "current"));
    for (const command of ["curl", "node", "systemctl", "stat", "flock"]) {
      await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    const jq = (await exec("sh", ["-c", "command -v jq"])).stdout.trim();
    await symlink(jq, join(bin, "jq"));

    await expect(exec("sh", [`${operationsRoot}/rollback-release.sh`, targetSha], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PIH_ROOT: root, PIH_CONNECTORS_ROOT: join(root, "host-connectors") },
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("not the immediate predecessor"),
    });
  });

  it("rolls back a pre-connectors release using the active release predecessor service state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pih-legacy-rollback-"));
    temporaryDirectories.push(root);
    const targetSha = "e".repeat(40);
    const activeSha = "f".repeat(40);
    const targetRelease = join(root, "releases", targetSha);
    const activeRelease = join(root, "releases", activeSha);
    const connectorsRoot = join(root, "host-connectors");
    const activeRuntime = join(connectorsRoot, "releases", activeSha);
    const bin = join(root, "bin");
    const oldEnvironment = join(root, "config/releases", `${targetSha}.compose.env`);
    const activeEnvironment = join(root, "config/releases", `${activeSha}.compose.env`);
    const deployerEnvironment = join(root, "secrets/connectors-deployer.env");
    const systemdState = join(root, "systemd.state");
    const systemdLog = join(root, "systemd.log");
    const dockerLog = join(root, "docker.log");
    const nodeLog = join(root, "node.log");
    const jq = (await exec("sh", ["-c", "command -v jq"])).stdout.trim();

    await mkdir(join(targetRelease, "infrastructure/docker"), { recursive: true });
    await mkdir(join(activeRelease, "infrastructure/docker"), { recursive: true });
    await mkdir(join(activeRelease, "infrastructure/operations"), { recursive: true });
    await mkdir(join(root, "config/releases"), { recursive: true });
    await mkdir(join(root, "secrets"), { recursive: true });
    await mkdir(join(connectorsRoot, "releases"), { recursive: true });
    await mkdir(join(activeRuntime, "dist/src/migrations"), { recursive: true });
    await mkdir(bin);
    await writeFile(join(targetRelease, "infrastructure/docker/compose.production.yaml"), "services: {}\n");
    await writeFile(join(activeRelease, "infrastructure/docker/compose.production.yaml"), "services: {}\n");
    await writeFile(join(activeRuntime, "dist/src/main.js"), "");
    await writeFile(oldEnvironment, "PIH_WEB_PORT=3000\n");
    await writeFile(activeEnvironment, "PIH_WEB_PORT=3000\n");
    await writeFile(join(targetRelease, "release-manifest.json"), JSON.stringify({ gitSha: targetSha, images: [] }));
    await writeFile(
      join(activeRelease, "infrastructure/operations/check-connectors-migration-baseline.mjs"),
      await readFile(join(operationsRoot, "check-connectors-migration-baseline.mjs"), "utf8"),
    );
    await writeFile(join(activeRelease, "release-manifest.json"), JSON.stringify({
      gitSha: activeSha,
      images: [],
      connectors: {
        migrationHistoryFormatVersion: 1,
        migrations: ["0000_foundation", "0001_provider"],
        runtimeDirectory: activeRuntime,
        previousReleaseSha: targetSha,
        previousConnectorsRuntime: null,
        previousConnectorsEnabled: "disabled",
        previousConnectorsActive: "inactive",
        enabled: "enabled",
        active: "active",
      },
    }));
    await symlink(activeRelease, join(root, "current"));
    await symlink(activeEnvironment, join(root, "config/current-compose.env"));
    await symlink(activeRuntime, join(connectorsRoot, "current"));
    await writeFile(deployerEnvironment, [
      "CONNECTORS_DEPLOYER_SERVICE_TOKEN=fictional-deployer-token-32-bytes-minimum",
      "CONNECTORS_DEPLOYER_ISSUER=pih-deployer",
      `CONNECTORS_DEPLOYER_SIGNING_KEY=${Buffer.alloc(32, 7).toString("base64url")}`,
      "CONNECTORS_DEPLOYER_ACTOR_ID=service:pih-deployer",
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(systemdState, "enabled active\n");
    await symlink(jq, join(bin, "jq"));
    const commands: Record<string, string> = {
      docker: `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$DOCKER_LOG"
printf 'docker %s\n' "$*" >> "$EVENT_LOG"
exit 0
`,
      curl: "#!/bin/sh\nexit 0\n",
      node: `#!/bin/sh
printf '%s\n' "$*" >> "$NODE_LOG"
exit 0
`,
      systemctl: `#!/bin/sh
set -eu
action=$1
printf '%s\n' "$*" >> "$SYSTEMD_LOG"
printf 'systemctl %s\n' "$*" >> "$EVENT_LOG"
set -- $(cat "$SYSTEMD_STATE")
enabled=$1
active=$2
case "$action" in
  is-enabled) printf '%s\n' "$enabled"; [ "$enabled" = enabled ] ;;
  is-active) printf '%s\n' "$active"; [ "$active" = active ] ;;
  enable) enabled=enabled ;;
  disable) enabled=disabled ;;
  restart|start) active=active ;;
  stop) active=inactive ;;
  *) exit 1 ;;
esac
case "$action" in is-enabled|is-active) ;; *) printf '%s %s\n' "$enabled" "$active" > "$SYSTEMD_STATE" ;; esac
`,
      stat: "#!/bin/sh\nprintf '0:600\n'\n",
    };
    for (const [name, contents] of Object.entries(commands)) {
      await writeFile(join(bin, name), contents, { mode: 0o700 });
    }

    await exec("sh", [`${operationsRoot}/rollback-release.sh`, targetSha], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PIH_ROOT: root,
        PIH_CONNECTORS_ROOT: connectorsRoot,
        CONNECTORS_DEPLOYER_ENV_FILE: deployerEnvironment,
        SYSTEMD_STATE: systemdState,
        SYSTEMD_LOG: systemdLog,
        DOCKER_LOG: dockerLog,
        NODE_LOG: nodeLog,
        EVENT_LOG: join(root, "events.log"),
      },
    });

    await expect(readlink(join(connectorsRoot, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readlink(join(root, "current"))).toBe(targetRelease);
    expect(await readlink(join(root, "config/current-compose.env"))).toBe(oldEnvironment);
    expect((await readFile(systemdState, "utf8")).trim()).toBe("disabled inactive");
    expect((await readFile(dockerLog, "utf8"))).toMatch(/compose[\s\S]*up --detach/u);
    expect(await readFile(nodeLog, "utf8")).toContain("check-connectors-migration-baseline.mjs rollback");
    expect(await readFile(nodeLog, "utf8")).not.toContain("check-connectors-readiness.mjs");
    const events = await readFile(join(root, "events.log"), "utf8");
    expect(events.indexOf("systemctl disable personal-intelligence-hub-connectors.service")).toBeLessThan(
      events.indexOf("docker compose"),
    );
    expect(events.indexOf("systemctl stop personal-intelligence-hub-connectors.service")).toBeLessThan(
      events.indexOf("docker compose"),
    );
  });

describe("Restic lock guard", () => {
  const prepareFakeRestic = async (pid: number) => {
    const directory = await mkdtemp(join(tmpdir(), "pih-restic-lock-"));
    temporaryDirectories.push(directory);
    const restic = join(directory, "restic");
    const state = join(directory, "unlocked");
    const log = join(directory, "calls.log");
    await writeFile(
      restic,
      `#!/bin/sh
set -eu
if [ "$1 \${2:-}" = "list locks" ]; then
  if [ -e "$RESTIC_LOCK_STATE" ]; then
    printf '[]\\n'
  else
    printf '[{"hostname":"test-host","pid":${pid},"time":"2000-01-01T00:00:00Z"}]\\n'
  fi
elif [ "$1" = "unlock" ]; then
  printf 'unlock\\n' >> "$RESTIC_LOCK_LOG"
  : > "$RESTIC_LOCK_STATE"
else
  exit 64
fi
`,
      { mode: 0o700 },
    );
    return { restic, state, log };
  };

  it("repairs only a proven old local orphan", async () => {
    const fixture = await prepareFakeRestic(999_999);
    const environment = {
      ...process.env,
      RESTIC_BIN: fixture.restic,
      RESTIC_HOSTNAME: "test-host",
      RESTIC_LOCK_LOG: fixture.log,
      RESTIC_LOCK_STATE: fixture.state,
      RESTIC_NOW_EPOCH: "1767225600",
      RESTIC_STALE_LOCK_SECONDS: "3600",
    };

    await expect(
      exec("sh", [`${operationsRoot}/restic-lock-guard.sh`], { env: environment }),
    ).rejects.toMatchObject({ code: 3 });
    await expect(
      exec("sh", [`${operationsRoot}/restic-lock-guard.sh`, "--repair"], {
        env: environment,
      }),
    ).resolves.toBeDefined();
    await expect(readFile(fixture.log, "utf8")).resolves.toBe("unlock\n");
  });

  it("refuses to unlock a lock whose process is still alive", async () => {
    const fixture = await prepareFakeRestic(process.pid);
    await expect(
      exec("sh", [`${operationsRoot}/restic-lock-guard.sh`, "--repair"], {
        env: {
          ...process.env,
          RESTIC_BIN: fixture.restic,
          RESTIC_HOSTNAME: "test-host",
          RESTIC_LOCK_LOG: fixture.log,
          RESTIC_LOCK_STATE: fixture.state,
          RESTIC_NOW_EPOCH: "1767225600",
          RESTIC_STALE_LOCK_SECONDS: "3600",
        },
      }),
    ).rejects.toMatchObject({ code: 2 });
  });
});

describe("connectors host configuration examples", () => {
  it("keeps required private connector values blank and uses only safe defaults", async () => {
    const example = await readFile(
      `${repositoryRoot}/infrastructure/operations/config/connectors.env.example`,
      "utf8",
    );
    const values = new Map(
      example.split(/\r?\n/u)
        .filter((line) => /^[A-Z0-9_]+=/.test(line))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(values.get("NODE_ENV")).toBe("production");
    expect(values.get("CONNECTORS_SOCKET_PATH")).toBe("/run/pih-connectors/web/connectors.sock");
    expect(values.get("CONNECTORS_SOCKET_GID")).toBe("");
    expect(values.get("CONNECTORS_DATABASE_PATH")).toBe("/var/lib/pih-connectors/connectors.sqlite");
    expect(values.get("CONNECTORS_SERVICE_CREDENTIALS_JSON")).toBe("");
    expect(values.get("DEFAULT_TIME_ZONE")).toBe("Etc/UTC");
    expect(values.get("LOG_LEVEL")).toBe("info");
    expect(example).toContain("getent group pih-connectors-clients");
    expect(example).toContain("generated directly into the private installation file");
  });
});
