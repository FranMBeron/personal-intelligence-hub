import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = "infrastructure/docker/compose.yaml";
const project = `pih-compose-${process.pid}`;
const apiPort = 43_101;
const webPort = 43_100;
const socketSource = join(tmpdir(), `pih-compose-connectors-${process.pid}`);
const clientGid = process.getgid?.();
if (clientGid === undefined) throw new Error("Compose socket test requires a Unix group ID");
const environment = {
  ...process.env,
  PIH_API_PORT: String(apiPort),
  PIH_WEB_PORT: String(webPort),
  PIH_CONNECTORS_SOCKET_SOURCE: socketSource,
  PIH_CONNECTORS_CLIENT_GID: String(clientGid),
};

const compose = (...args: string[]) =>
  exec(
    "docker",
    ["compose", "-f", composeFile, "-p", project, ...args],
    {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

const waitForLive = async (): Promise<Response> => {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/health/live`);
      if (response.ok) return response;
      lastError = new Error(`Unexpected liveness status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError instanceof Error ? lastError : new Error("API did not become live");
};

const waitForWeb = async (): Promise<Response> => {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${webPort}/health`);
      if (response.ok) return response;
      lastError = new Error(`Unexpected web health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError instanceof Error ? lastError : new Error("Web did not become live");
};

describe("local Docker Compose", () => {
  beforeAll(async () => { await mkdir(socketSource, { recursive: true }); });
  afterAll(async () => {
    await compose("down", "--volumes", "--remove-orphans").catch(() => undefined);
    await rm(socketSource, { recursive: true, force: true });
  }, 120_000);

  test(
    "starts the full stack, migrates once, survives restart and keeps PostgreSQL private",
    async () => {
      const { stdout: rendered } = await compose("config", "--format", "json");
      const configuration = JSON.parse(rendered) as {
        services: Record<string, { ports?: unknown[]; volumes?: unknown[]; group_add?: unknown[] }>;
      };
      expect(configuration.services.postgres?.ports ?? []).toEqual([]);
      expect(configuration.services.migrate).toBeDefined();
      expect(configuration.services.api).toBeDefined();
      expect(configuration.services.web).toBeDefined();
      expect(configuration.services.web?.volumes).toEqual(expect.arrayContaining([expect.objectContaining({ source: socketSource, target: "/run/pih-connectors", read_only: true })]));
      expect(configuration.services.web?.group_add).toContain(String(clientGid));

      await compose("up", "--build", "--detach", "--wait");
      await expect((await waitForLive()).json()).resolves.toEqual({ status: "ok" });
      await expect((await waitForWeb()).json()).resolves.toEqual({ status: "ok" });

      const { stdout: migratedTable } = await compose(
        "exec",
        "--no-TTY",
        "postgres",
        "psql",
        "--username",
        "pih_local",
        "--dbname",
        "pih_local",
        "--tuples-only",
        "--no-align",
        "--command",
        "select to_regclass('public.outbox_events')",
      );
      expect(migratedTable.trim()).toBe("outbox_events");

      await compose("restart", "api");
      await expect((await waitForLive()).json()).resolves.toEqual({ status: "ok" });
      const { stdout: migrationCount } = await compose(
        "exec",
        "--no-TTY",
        "postgres",
        "psql",
        "--username",
        "pih_local",
        "--dbname",
        "pih_local",
        "--tuples-only",
        "--no-align",
        "--command",
        "select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'outbox_events'",
      );
      expect(migrationCount.trim()).toBe("1");

      await compose("run", "--rm", "migrate");
      const { stdout: ledgerCount } = await compose(
        "exec",
        "--no-TTY",
        "postgres",
        "psql",
        "--username",
        "pih_local",
        "--dbname",
        "pih_local",
        "--tuples-only",
        "--no-align",
        "--command",
        "select count(*) from pih_schema_migrations where name = '0000_initial.sql'",
      );
      expect(ledgerCount.trim()).toBe("1");
    },
    600_000,
  );
});
