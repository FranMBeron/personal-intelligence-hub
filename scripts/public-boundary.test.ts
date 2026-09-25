import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

describe("public repository boundary", () => {
  it("tracks no local-only or secret file class", async () => {
    const { stdout } = await exec("git", [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ], {
      cwd: repositoryRoot,
      encoding: "buffer",
    });
    const paths = stdout.toString("utf8").split("\0").filter(Boolean);

    expect(paths.some((path) => path.startsWith(".local-docs/"))).toBe(false);
    expect(
      paths.filter(
        (path) =>
          /(?:^|\/)\.env$/u.test(path) ||
          /\.(?:pem|key|p12|sqlite|db|tar|zip)$/u.test(path),
      ),
    ).toEqual([]);
  });

  it("contains no private host or previous-install identity", async () => {
    const { stdout } = await exec("git", [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ], {
      cwd: repositoryRoot,
      encoding: "buffer",
    });
    const paths = stdout.toString("utf8").split("\0").filter(Boolean);
    const violations: string[] = [];

    for (const path of paths) {
      if (path === "scripts/public-boundary.test.ts") continue;
      const content = await readFile(`${repositoryRoot}/${path}`, "utf8");
      if (/remote-station|\/srv\/mi-estacion|\/home\/franmb|FranMBeron/iu.test(content)) {
        violations.push(path);
      }
    }

    expect(violations).toEqual([]);
  });
});
