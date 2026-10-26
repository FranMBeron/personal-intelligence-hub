// Re-runs the foundation database, migration and backup suites against a
// packaged set that also contains an additive provider migration, the way
// the Hermes and Calendar branches extend it. The real directory is still
// used whenever a caller passes one explicitly (the pinned loader test).
import { vi } from "vitest";

import type * as MigrationsModule from "./migrations.js";

vi.mock("./migrations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof MigrationsModule>();
  const providerFixture = {
    "0100_provider_fixture":
      "CREATE TABLE provider_fixture_items(id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL);",
  };
  return {
    ...actual,
    loadMigrations: (directory?: URL) => {
      if (directory !== undefined) return actual.loadMigrations(directory);
      const packaged = Object.fromEntries(
        actual.loadMigrations().map(({ name, sql }) => [name, sql]),
      );
      return actual.migrations({ ...packaged, ...providerFixture });
    },
  };
});

import "./migrations.test.js";
import "./database.test.js";
import "./backup.test.js";
