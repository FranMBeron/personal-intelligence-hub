import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function isGenericDesktopTooling(content: string): boolean {
  const settings = content.split(/\r?\n/u).map((line) => line.trim())
    .filter((line) => line && !/^[#;]/u.test(line));
  return settings.length === 1 && settings[0] === "hoist-pattern[]=*";
}

function forbiddenDesktopPath(path: string, tracked: boolean): boolean {
  if (path.startsWith("apps/desktop/out/")) return tracked;
  if (/(?:^|\/)[^/]+\.(?:dmg|app)(?:\/|$)/iu.test(path)) return true;
  if (/\.icns$/iu.test(path)) return path !== "apps/desktop/assets/icon.icns";
  if (!path.startsWith("apps/desktop/")) return false;
  return /(?:^|\/)(?:settings\.json|\.npmrc|\.config(?:\/|$)|\.env(?:\.|$))/iu.test(path) ||
    /(?:^|\/)(?:config|configuration|credentials|secrets|private|hosts?)(?:\/|[.-])/iu.test(path) ||
    /(?:^|[./-])(?:local|machine|user)(?:[.-])[^/]*\.(?:json|ya?ml|toml|ini|conf|[cm]?ts|[cm]?js)$/iu.test(path);
}

function forbiddenPath(path: string, tracked = false): boolean {
  return forbiddenDesktopPath(path, tracked) ||
    path.startsWith(".local-docs/") ||
    /(?:^|\/)\.env$/u.test(path) ||
    /\.(?:pem|key|p12|sqlite|db|tar|zip)$/u.test(path);
}

async function repositoryPaths(cwd: string): Promise<{ paths: string[]; tracked: Set<string>; publicPaths: string[] }> {
  const list = async (args: string[]): Promise<string[]> => {
    const { stdout } = await exec("git", ["ls-files", "-z", ...args], { cwd, encoding: "buffer" });
    return stdout.toString("utf8").split("\0").filter(Boolean);
  };
  const tracked = await list(["--cached"]);
  const visible = await list(["--others", "--exclude-standard"]);
  const ignored = await list([
    "--others", "--ignored", "--exclude-standard", "--", ".",
    ":(exclude,glob)**/node_modules/**", ":(exclude,glob).worktrees/**",
  ]);
  return {
    // Existing local data stays private; inspect ignored desktop artifacts/settings too.
    paths: [...tracked, ...visible, ...ignored.filter((path) => forbiddenDesktopPath(path, false) || path.startsWith("apps/desktop/out/"))],
    tracked: new Set(tracked), publicPaths: [...tracked, ...visible],
  };
}

describe("desktop file boundary policy", () => {
  it("allows the generic pnpm layout declaration but rejects host or registry settings", () => {
    expect(isGenericDesktopTooling("# Generic packaging support\nhoist-pattern[]=*\n")).toBe(true);
    expect(isGenericDesktopTooling("hoist-pattern[]=*\nregistry=https://registry.example.test\n")).toBe(false);
    expect(isGenericDesktopTooling("hoist-pattern[]=*\nstore-dir=/tmp/private-store\n")).toBe(false);
    expect(isGenericDesktopTooling("registry=https://registry.example.test\n")).toBe(false);
  });
  it("discovers ignored local desktop settings and artifacts but preserves tracked status", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-boundary-"));
    try {
      await exec("git", ["init", "--quiet", root]);
      await writeFile(join(root, ".gitignore"), "apps/desktop/out/\n*.dmg\nsettings.json\n");
      await mkdir(join(root, "apps/desktop/out"), { recursive: true });
      await writeFile(join(root, "ignored.dmg"), "");
      await writeFile(join(root, "apps/desktop/settings.json"), "{}");
      await writeFile(join(root, "apps/desktop/out/local.dmg"), "");
      await writeFile(join(root, "apps/desktop/out/tracked.dmg"), "");
      await exec("git", ["add", "-f", "apps/desktop/out/tracked.dmg"], { cwd: root });
      const inventory = await repositoryPaths(root);
      expect(inventory.paths).toEqual(expect.arrayContaining([
        "ignored.dmg", "apps/desktop/settings.json", "apps/desktop/out/local.dmg", "apps/desktop/out/tracked.dmg",
      ]));
      expect(inventory.tracked.has("apps/desktop/out/tracked.dmg")).toBe(true);
      expect(inventory.tracked.has("apps/desktop/out/local.dmg")).toBe(false);
      expect(inventory.publicPaths).not.toContain("apps/desktop/out/local.dmg");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the repository to ignore generated desktop packages", async () => {
    const { stdout } = await exec("git", ["check-ignore", "apps/desktop/out/policy-check.dmg"], {
      cwd: repositoryRoot,
    });
    expect(stdout.trim()).toBe("apps/desktop/out/policy-check.dmg");
  });

  it.each([
    "release.dmg", "release.DMG", "release.app/Contents/Info.plist",
    "assets/other.icns", "apps/desktop/assets/other.icns",
    "apps/desktop/settings.json", "apps/desktop/config/host.json",
    "apps/desktop/local.config.json", "apps/desktop/.env.local",
    "apps/desktop/.npmrc", "apps/desktop/.config/client.json",
  ])("rejects local application or host configuration: %s", (path) => {
    expect(forbiddenPath(path)).toBe(true);
    expect(forbiddenPath(path, true)).toBe(true);
  });

  it("allows only untracked generated desktop output and the approved icon", () => {
    expect(forbiddenPath("apps/desktop/out/release.dmg")).toBe(false);
    expect(forbiddenPath("apps/desktop/out/release.app/Contents/Info.plist")).toBe(false);
    expect(forbiddenPath("apps/desktop/assets/icon.icns", true)).toBe(false);
    expect(forbiddenPath("apps/desktop/out/release.dmg", true)).toBe(true);
    expect(forbiddenPath("apps/desktop/out/metadata.json", true)).toBe(true);
    expect(forbiddenPath("apps/desktop/forge.config.ts", true)).toBe(false);
  });
});

describe("public repository boundary", () => {
  it("tracks no local-only or secret file class", async () => {
    const { paths, tracked } = await repositoryPaths(repositoryRoot);
    const violations: string[] = [];
    for (const path of paths) {
      if (!forbiddenPath(path, tracked.has(path))) continue;
      // This committed build prerequisite is generic; all other npmrc options
      // (including registries, credentials and host paths) stay disallowed.
      if (path === "apps/desktop/.npmrc" &&
        isGenericDesktopTooling(await readFile(join(repositoryRoot, path), "utf8"))) continue;
      violations.push(path);
    }
    expect(violations).toEqual([]);
  });

  it("contains no private host or previous-install identity", async () => {
    const { publicPaths: paths } = await repositoryPaths(repositoryRoot);
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
