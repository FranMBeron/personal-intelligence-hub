import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

it("executes the migration CLI through a package symlink instead of silently exiting", () => {
  const directory = mkdtempSync(join(tmpdir(), "pih-migrate-cli-"));
  const entry = join(directory, "migrate.ts");
  const { DATABASE_URL: _databaseUrl, ...environment } = process.env;
  try {
    symlinkSync(fileURLToPath(new URL("./migrate.ts", import.meta.url)), entry);
    const result = spawnSync(process.execPath, ["--import", "tsx", entry], {
      env: environment,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is required to run database migrations.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
