import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * Hermetic release fixture: every host path lives below a temporary root and
 * every privileged command (systemd, Docker, Restic, the connectors runtime)
 * is a fake that records events. Nothing here touches the real host.
 */
export const exec = promisify(execFile);
export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
export const operationsRoot = `${repositoryRoot}/infrastructure/operations`;

export const oldSha = "d".repeat(40);
export const candidateSha = "c".repeat(40);

const fakes: Record<string, string> = {
  "systemd-run": `#!/bin/sh
set -eu
printf 'systemd-run %s\\n' "$*" >> "$EVENT_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -p)
      case "$2" in
        EnvironmentFile=*)
          file=\${2#EnvironmentFile=}
          set -a
          . "$file"
          set +a
          ;;
      esac
      shift 2
      ;;
    -E) export "$2"; shift 2 ;;
    --*) shift ;;
    *) printf 'fake systemd-run: unexpected argument\\n' >&2; exit 2 ;;
  esac
done
exec "$@"
`,
  node: `#!/bin/sh
set -eu
script=$1
shift
option() {
  name=$1
  shift
  while [ "$#" -gt 1 ]; do
    if [ "$1" = "$name" ]; then printf '%s\\n' "$2"; return 0; fi
    shift
  done
  return 1
}
case "$script" in
  *check-connectors-migration-baseline.mjs) exit 0 ;;
  *check-connectors-readiness.mjs)
    count=0
    [ ! -f "$READINESS_COUNT" ] || count=$(cat "$READINESS_COUNT")
    count=$((count + 1))
    printf '%s\\n' "$count" > "$READINESS_COUNT"
    runtime=$(basename "$(readlink "$CONNECTORS_CURRENT_LINK" 2>/dev/null || echo none)")
    case " \${READINESS_FAIL_AT:-} " in
      *" $count "*) printf 'readiness-failed %s\\n' "$runtime" >> "$EVENT_LOG"; exit 1 ;;
    esac
    printf 'readiness-ok %s\\n' "$runtime" >> "$EVENT_LOG"
    ;;
  */dist/src/operations/backup-command.js)
    runtime=$(basename "\${script%/dist/src/operations/backup-command.js}")
    destination=$(option --destination "$@")
    database=$(option --database "$@")
    [ -z "\${FAIL_BACKUP_ADAPTER:-}" ] || exit 1
    [ "$database" = "$CONNECTORS_DATABASE_PATH" ] || exit 1
    [ ! -e "$destination" ] || exit 1
    mkdir -m 700 "$destination"
    cp "$database" "$destination/connectors.sqlite"
    sha=$(sha256sum "$destination/connectors.sqlite" | cut -d' ' -f1)
    printf '{"formatVersion":1,"databaseSha256":"%s"}\\n' "$sha" > "$destination/manifest.json"
    printf 'backup-adapter %s\\n' "$runtime" >> "$EVENT_LOG"
    printf '{"result":"backup_complete"}\\n'
    ;;
  */dist/src/operations/restore-command.js)
    runtime=$(basename "\${script%/dist/src/operations/restore-command.js}")
    backup=$(option --backup "$@")
    manifest=$(option --manifest "$@")
    target=$(option --target "$@")
    printf 'restore-adapter %s %s\\n' "$runtime" "$target" >> "$EVENT_LOG"
    [ -z "\${FAIL_RESTORE_ADAPTER:-}" ] || exit 1
    [ -n "\${CONNECTORS_DATABASE_PATH:-}" ] || exit 1
    [ ! -e "$target" ] || exit 1
    [ "$(sha256sum "$backup" | cut -d' ' -f1)" = "$(jq -r .databaseSha256 "$manifest")" ] || exit 1
    cp "$backup" "$target"
    printf '{"result":"restore_complete"}\\n'
    ;;
  *) exit 0 ;;
esac
`,
  systemctl: `#!/bin/sh
set -eu
action=$1
runtime=$(basename "$(readlink "$CONNECTORS_CURRENT_LINK" 2>/dev/null || echo none)")
printf 'systemctl %s %s\\n' "$action" "$runtime" >> "$EVENT_LOG"
set -- $(cat "$SYSTEMD_STATE")
enabled=$1
active=$2
case "$action" in
  is-enabled) printf '%s\\n' "$enabled"; [ "$enabled" = enabled ]; exit ;;
  is-active) printf '%s\\n' "$active"; [ "$active" = active ]; exit ;;
  enable) enabled=enabled ;;
  disable) enabled=disabled ;;
  restart|start)
    active=active
    if [ "$runtime" = "$CANDIDATE_RUNTIME_NAME" ]; then printf 'candidate-migrated\\n' >> "$TEST_DATABASE"; fi
    ;;
  stop) [ -z "\${FAIL_STOP:-}" ] || exit 1; active=inactive ;;
  *) exit 1 ;;
esac
printf '%s %s\\n' "$enabled" "$active" > "$SYSTEMD_STATE"
`,
  docker: `#!/bin/sh
set -eu
printf 'docker %s\\n' "$*" >> "$EVENT_LOG"
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  if [ "\${3:-}" = "--format" ]; then printf 'sha256:fixture-image-id\\n'; exit 0; fi
  if [ "$#" -eq 3 ]; then exit 1; fi
  printf '[]\\n'
  exit 0
fi
case "$1" in
  build)
    if [ -n "\${BUILD_BLOCK_FILE:-}" ]; then
      : > "$BUILD_STARTED_FILE"
      while [ ! -e "$BUILD_BLOCK_FILE" ]; do sleep 0.05; done
    fi
    ;;
  create) printf 'connector-export-container\\n' ;;
  cp)
    mkdir -p "$3/dist/src/migrations" "$3/dist/src/operations"
    cp "$TEST_MIGRATIONS"/*.sql "$3/dist/src/migrations/"
    : > "$3/dist/src/main.js"
    : > "$3/dist/src/operations/backup-command.js"
    : > "$3/dist/src/operations/restore-command.js"
    ;;
  compose)
    case " $* " in
      *" exec "*" sh "*) printf 'fictional-dump\\n' ;;
      *" up "*) [ -z "\${FAIL_COMPOSE_UP:-}" ] || exit 1 ;;
    esac
    ;;
esac
exit 0
`,
  restic: `#!/bin/sh
set -eu
printf 'restic %s\\n' "$*" >> "$EVENT_LOG"
[ -n "\${RESTIC_REPOSITORY:-}" ] || exit 9
repository=$RESTIC_REPOSITORY
case "$1" in
  list) printf '[]\\n' ;;
  unlock|forget) ;;
  backup)
    [ -z "\${FAIL_RESTIC_BACKUP:-}" ] || exit 1
    source_directory=$2
    shift 2
    count=$(find "$repository" -mindepth 1 -maxdepth 1 -type d | wc -l)
    id=$(printf 'fictional-snapshot-%s' "$count" | sha256sum | cut -d' ' -f1)
    mkdir -p "$repository/$id/tree"
    cp -R "$source_directory" "$repository/$id/tree/"
    : > "$repository/$id/tags"
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--tag" ]; then printf '%s\\n' "$2" >> "$repository/$id/tags"; shift; fi
      shift
    done
    ;;
  check) [ -z "\${FAIL_RESTIC_CHECK:-}" ] || exit 1 ;;
  snapshots)
    tag=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--tag" ]; then tag=$2; shift; fi
      shift
    done
    separator=
    printf '['
    for snapshot in "$repository"/*/; do
      [ -f "$snapshot/tags" ] || continue
      if grep -qx -- "$tag" "$snapshot/tags"; then
        printf '%s{"id":"%s"}' "$separator" "$(basename "$snapshot")"
        separator=,
      fi
    done
    printf ']\\n'
    ;;
  restore)
    id=$2
    shift 2
    target=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--target" ]; then target=$2; shift; fi
      shift
    done
    [ -d "$repository/$id/tree" ] || exit 1
    mkdir -p "$target"
    cp -R "$repository/$id/tree/." "$target/"
    ;;
  *) exit 64 ;;
esac
`,
  stat: `#!/bin/sh
if [ "$1" = "-c" ] && [ "$3" = "$CONNECTORS_DEPLOYER_ENV_FILE" ]; then printf '0:600\\n'; exit 0; fi
exec /usr/bin/stat "$@"
`,
  chown: `#!/bin/sh
printf 'chown %s\\n' "$*" >> "$EVENT_LOG"
`,
  chmod: "#!/bin/sh\nexit 0\n",
  syft: `#!/bin/sh
for argument do case "$argument" in cyclonedx-json=*) : > "\${argument#*=}" ;; esac; done
`,
  grype: "#!/bin/sh\nexit 0\n",
  curl: "#!/bin/sh\nexit 0\n",
};

/**
 * Prepended to every fake: records each child that received a deployer credential in its
 * environment, so tests can prove only the readiness check ever does.
 */
const deployerEnvironmentProbe =
  "if env | grep -Eq '^CONNECTORS_DEPLOYER_(SERVICE_TOKEN|ISSUER|SIGNING_KEY|ACTOR_ID)='; then printf 'deployer-env %s %s\\n' \"${0##*/}\" \"${1:-}\" >> \"$EVENT_LOG\"; fi\n";
const withDeployerEnvironmentProbe = (contents: string): string =>
  contents.startsWith("#!/bin/sh\n") ? `#!/bin/sh\n${deployerEnvironmentProbe}${contents.slice("#!/bin/sh\n".length)}` : contents;

export type ReleaseFixture = Awaited<ReturnType<typeof createReleaseFixture>>;

export const createReleaseFixture = async (options: Readonly<{
  previousRuntime?: boolean;
  database?: boolean;
  adapters?: boolean;
  systemdState?: string;
  providerMigration?: boolean;
  extraFakes?: Readonly<Record<string, string>>;
}> = {}) => {
  const previousRuntime = options.previousRuntime ?? true;
  const database = options.database ?? true;
  const adapters = options.adapters ?? true;
  const root = await mkdtemp(join(tmpdir(), "pih-release-recovery-"));
  const bin = join(root, "bin");
  const candidateRelease = join(root, "releases", candidateSha);
  const oldRelease = join(root, "releases", oldSha);
  const connectorsRoot = join(root, "host-connectors");
  const oldRuntime = join(connectorsRoot, "releases", oldSha);
  const candidateRuntime = join(connectorsRoot, "releases", candidateSha);
  const migrations = join(candidateRelease, "apps/connectors/src/migrations");
  const databasePath = join(root, "var/pih-connectors/connectors.sqlite");
  const connectorsEnvironment = join(root, "etc/pih-connectors/connectors.env");
  const deployerEnvironment = join(root, "secrets/connectors-deployer.env");
  const resticRepository = join(root, "fake-restic-repository");
  const eventLog = join(root, "events.log");
  const systemdState = join(root, "systemd.state");
  const oldEnvironment = join(root, "config/releases", `${oldSha}.compose.env`);

  for (const directory of [
    bin,
    migrations,
    join(candidateRelease, "infrastructure/docker"),
    join(candidateRelease, "infrastructure/operations"),
    join(oldRelease, "infrastructure/docker"),
    join(oldRelease, "infrastructure/operations"),
    join(root, "config/releases"),
    join(root, "secrets"),
    join(connectorsRoot, "releases"),
    join(root, "var/pih-connectors"),
    join(root, "etc/pih-connectors"),
    resticRepository,
  ]) await mkdir(directory, { recursive: true });

  await writeFile(join(candidateRelease, "REVISION"), `${candidateSha}\n`);
  for (const release of [candidateRelease, oldRelease]) {
    await writeFile(join(release, "infrastructure/docker/compose.production.yaml"), "services: {}\n");
    for (const helper of ["backup.sh", "restic-lock-guard.sh", "check-connectors-migration-baseline.mjs"]) {
      await copyFile(join(operationsRoot, helper), join(release, "infrastructure/operations", helper));
    }
    await writeFile(join(release, "infrastructure/operations/check-connectors-readiness.mjs"), "export {};\n");
  }
  for (const name of ["api", "web", "postgres", "connectors-build"]) {
    await writeFile(join(candidateRelease, `infrastructure/docker/${name}.Dockerfile`), "FROM scratch\n");
  }
  await writeFile(join(migrations, "0000_foundation.sql"), "CREATE TABLE fixture(id TEXT);\n");
  if (options.providerMigration === true) {
    await writeFile(join(migrations, "0001_provider.sql"), "CREATE TABLE provider_fixture(id TEXT);\n");
  }
  await writeFile(join(oldRelease, "release-manifest.json"), JSON.stringify({
    gitSha: oldSha,
    images: [],
    connectors: {
      runtimeDirectory: oldRuntime,
      migrationHistoryFormatVersion: 1,
      migrations: ["0000_foundation"],
      enabled: "enabled",
      active: "active",
    },
  }));
  await writeFile(oldEnvironment, "PIH_WEB_PORT=3000\n");
  await symlink(oldRelease, join(root, "current"));
  await symlink(oldEnvironment, join(root, "config/current-compose.env"));
  await writeFile(join(root, "config/compose.env"), "POSTGRES_DB=fixture\nPIH_WEB_PORT=3000\n");
  await writeFile(join(root, "config/backup.env"), "PIH_BACKUP_KEEP_DAILY=7\n");
  await writeFile(join(root, "secrets/restic.env"), `RESTIC_REPOSITORY=${resticRepository}\n`);
  await writeFile(connectorsEnvironment, `NODE_ENV=production\nCONNECTORS_DATABASE_PATH='${databasePath}'\n`, { mode: 0o600 });
  await writeFile(deployerEnvironment, [
    "CONNECTORS_DEPLOYER_SERVICE_TOKEN=fictional-deployer-token-32-bytes-minimum",
    "CONNECTORS_DEPLOYER_ISSUER=pih-deployer",
    `CONNECTORS_DEPLOYER_SIGNING_KEY=${Buffer.alloc(32, 7).toString("base64url")}`,
    "CONNECTORS_DEPLOYER_ACTOR_ID=service:pih-deployer",
    "",
  ].join("\n"), { mode: 0o600 });
  if (previousRuntime) {
    await mkdir(join(oldRuntime, "dist/src/migrations"), { recursive: true });
    await mkdir(join(oldRuntime, "dist/src/operations"), { recursive: true });
    await writeFile(join(oldRuntime, "dist/src/main.js"), "");
    if (adapters) {
      await writeFile(join(oldRuntime, "dist/src/operations/backup-command.js"), "");
      await writeFile(join(oldRuntime, "dist/src/operations/restore-command.js"), "");
    }
    await symlink(oldRuntime, join(connectorsRoot, "current"));
  }
  if (database) await writeFile(databasePath, "old-data\n", { mode: 0o600 });
  await writeFile(systemdState, `${options.systemdState ?? (previousRuntime ? "enabled active" : "disabled inactive")}\n`);
  for (const [name, contents] of Object.entries({ ...fakes, ...options.extraFakes })) {
    await writeFile(join(bin, name), withDeployerEnvironmentProbe(contents), { mode: 0o700 });
  }

  const environment = (extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PIH_ROOT: root,
    PIH_CONNECTORS_ROOT: connectorsRoot,
    PIH_CONNECTORS_DATABASE_PATH: databasePath,
    PIH_CONNECTORS_ENV_FILE: connectorsEnvironment,
    PIH_CONNECTORS_NODE: join(bin, "node"),
    CONNECTORS_DEPLOYER_ENV_FILE: deployerEnvironment,
    CONNECTORS_CURRENT_LINK: join(connectorsRoot, "current"),
    CANDIDATE_RUNTIME_NAME: candidateSha,
    TEST_DATABASE: databasePath,
    TEST_MIGRATIONS: migrations,
    EVENT_LOG: eventLog,
    SYSTEMD_STATE: systemdState,
    READINESS_COUNT: join(root, "readiness.count"),
    ...extra,
  });

  const run = (script: string, args: readonly string[], extra: Readonly<Record<string, string>> = {}) =>
    exec("sh", [join(operationsRoot, script), ...args], { env: environment(extra) });

  const events = async (): Promise<string[]> => {
    try {
      return (await readFile(eventLog, "utf8")).trim().split("\n");
    } catch {
      return [];
    }
  };

  const stagingLeftovers = async (): Promise<string[]> => {
    const leftovers: string[] = [];
    const backups = join(root, "backups");
    let entries: string[] = [];
    try {
      entries = await readdir(backups);
    } catch {
      return leftovers;
    }
    for (const entry of entries) {
      if (entry.startsWith("staging.")) leftovers.push(entry);
      if (entry === "connectors-staging") {
        leftovers.push(...(await readdir(join(backups, entry))).map((name) => `${entry}/${name}`));
      }
    }
    return leftovers;
  };

  return {
    root,
    bin,
    candidateRelease,
    oldRelease,
    connectorsRoot,
    oldRuntime,
    candidateRuntime,
    databasePath,
    resticRepository,
    systemdState,
    environment,
    run,
    events,
    stagingLeftovers,
  };
};
