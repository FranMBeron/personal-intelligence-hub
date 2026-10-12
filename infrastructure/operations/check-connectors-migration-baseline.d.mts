export type ConnectorReleaseManifest = Readonly<{
  gitSha?: string;
  connectors?: Readonly<{
    migrationHistoryFormatVersion?: number;
    migrations?: readonly string[];
  }>;
}>;

export function assertDeployBaseline(
  candidateMigrations: readonly string[],
  activeManifest: ConnectorReleaseManifest | null,
  priorServiceState?: "active" | "inactive" | string,
): void;

export function assertRollbackBaseline(
  activeManifest: ConnectorReleaseManifest | null,
  targetManifest: ConnectorReleaseManifest,
  targetServiceState?: "active" | "inactive" | string,
): void;
