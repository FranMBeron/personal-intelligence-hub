import { readFile } from "node:fs/promises";

const validName = (name) => typeof name === "string" && /^[0-9][A-Za-z0-9_-]*$/u.test(name);

const migrationList = (manifest) => {
  const connectors = manifest?.connectors;
  if (connectors?.migrationHistoryFormatVersion !== 1 || !Array.isArray(connectors.migrations)) {
    return null;
  }
  const names = connectors.migrations;
  if (names.some((name, index) => !validName(name) || (index > 0 && names[index - 1] >= name))) {
    throw new Error("Connectors release manifest has an invalid migration list.");
  }
  if (names.length === 0 || names[0] !== "0000_foundation") {
    throw new Error("Connectors release manifest has an invalid migration prefix.");
  }
  return names;
};

const isPrefix = (prefix, full) =>
  prefix !== null && prefix.length <= full.length && prefix.every((name, index) => name === full[index]);

export const assertDeployBaseline = (
  candidateMigrations,
  activeManifest,
  priorServiceState = "active",
) => {
  if (!Array.isArray(candidateMigrations) || candidateMigrations.length === 0 ||
      candidateMigrations.some((name, index) => !validName(name) ||
        (index > 0 && candidateMigrations[index - 1] >= name)) ||
      candidateMigrations[0] !== "0000_foundation") {
    throw new Error("Candidate connectors migration list is invalid.");
  }
  if (candidateMigrations.length <= 1) return;
  const active = migrationList(activeManifest);
  if (active === null) {
    if (priorServiceState !== "active") return;
    throw new Error("Provider migrations require a history-compatible active baseline while connectors are active.");
  }
  if (!isPrefix(active, candidateMigrations)) {
    throw new Error("Active baseline migration list is not an exact candidate migration prefix.");
  }
};

export const assertRollbackBaseline = (activeManifest, targetManifest, targetServiceState = "active") => {
  const active = migrationList(activeManifest);
  if (active === null) {
    if (targetServiceState === "inactive") return;
    throw new Error("Active connectors release is missing migration-history metadata.");
  }
  if (active.length <= 1) return;
  const target = migrationList(targetManifest);
  if (target === null) {
    if (targetServiceState === "inactive") return;
    throw new Error("Provider migration history requires a history-compatible active rollback target.");
  }
  if (!isPrefix(target, active)) {
    throw new Error("Rollback target migration list is not an exact active migration prefix.");
  }
};

const main = async () => {
  const [, , mode, candidatePath, activePath, targetPath, serviceState] = process.argv;
  const candidate = (await readFile(candidatePath, "utf8"))
    .split("\n").filter(Boolean).map((name) => name.replace(/\.sql$/u, ""));
  const active = activePath && activePath !== "-" ? JSON.parse(await readFile(activePath, "utf8")) : null;
  if (mode === "deploy") assertDeployBaseline(candidate, active, targetPath ?? "active");
  else if (mode === "rollback") {
    const target = JSON.parse(await readFile(targetPath, "utf8"));
    assertRollbackBaseline(active, target, serviceState ?? "active");
  } else {
    throw new Error("Usage: check-connectors-migration-baseline.mjs deploy <candidate-list> <active-manifest-or-> <active|inactive> | rollback <candidate-list> <active-manifest> <target-manifest> <active|inactive>");
  }
};

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Migration baseline check failed.");
    process.exitCode = 1;
  });
}
