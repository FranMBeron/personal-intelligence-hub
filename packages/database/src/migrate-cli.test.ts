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

it("allows import-only use of the database package from stdin", () => {
  const indexUrl = new URL("./index.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    input: `await import(${JSON.stringify(indexUrl)}); console.log('imported');`,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).toBe("imported");
});


it.each([undefined, "/nonexistent-pih-entrypoint", tmpdir()])("ignores a missing or non-file entrypoint %s during library import", (entrypoint) => {
  const indexUrl = new URL("./index.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    input: `process.argv[1] = ${JSON.stringify(entrypoint)}; await import(${JSON.stringify(indexUrl)}); console.log('imported');`,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).toBe("imported");
});
