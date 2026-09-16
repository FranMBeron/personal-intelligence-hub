import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = "infrastructure/docker/compose.yaml";
const project = `pih-compose-${process.pid}`;
const apiPort = 43_101;
const environment = {
  ...process.env,
  PIH_API_PORT: String(apiPort),
  PIH_WEB_PORT: "43100",
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

describe("local Docker Compose", () => {
  afterAll(async () => {
    await compose("down", "--volumes", "--remove-orphans").catch(() => undefined);
  }, 120_000);

  test(
    "starts PostgreSQL and API, migrates once, survives restart and keeps PostgreSQL private",
    async () => {
      const { stdout: rendered } = await compose("config", "--format", "json");
      const configuration = JSON.parse(rendered) as {
        services: Record<string, { ports?: unknown[] }>;
      };
      expect(configuration.services.postgres?.ports ?? []).toEqual([]);
      expect(configuration.services.api).toBeDefined();

      await compose("up", "--build", "--detach", "--wait", "api");
      await expect((await waitForLive()).json()).resolves.toEqual({ status: "ok" });

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
    },
    600_000,
  );
});
