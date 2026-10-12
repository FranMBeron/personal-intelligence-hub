import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

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
    const [application, backup] = await Promise.all([
      readFile(
        `${repositoryRoot}/infrastructure/systemd/personal-intelligence-hub.service`,
        "utf8",
      ),
      readFile(
        `${repositoryRoot}/infrastructure/systemd/personal-intelligence-hub-backup.service`,
        "utf8",
      ),
    ]);

    expect(application).toContain("After=network-online.target docker.service tailscaled.service");
    expect(application).toContain("NoNewPrivileges=true");
    expect(application).toContain("ProtectSystem=strict");
    expect(backup).toContain("OnFailure=personal-intelligence-hub-alert@%n.service");
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
