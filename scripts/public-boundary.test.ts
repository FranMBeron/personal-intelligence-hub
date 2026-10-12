import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function isApprovedDesktopTooling(content: string): boolean {
  return content === "# Declare pnpm's default explicitly for Electron Forge's package-manager check.\nhoist-pattern[]=*\n";
}

const approvedDesktopSourceConfigs = new Set([
  "apps/desktop/forge.config.ts",
  "apps/desktop/vite.main.config.ts",
  "apps/desktop/vite.preload.config.ts",
  "apps/desktop/vite.renderer.config.ts",
  "apps/desktop/tsconfig.json",
  "apps/desktop/package.json",
]);

function forbiddenDesktopPath(path: string, tracked: boolean): boolean {
  if (path.startsWith("apps/desktop/out/")) return tracked;
  if (/(?:^|\/)[^/]+\.(?:dmg|app)(?:\/|$)/iu.test(path)) return true;
  if (/\.icns$/iu.test(path)) return path !== "apps/desktop/assets/icon.icns";
  if (!path.startsWith("apps/desktop/")) return false;
  if (approvedDesktopSourceConfigs.has(path)) return false;
  // Vite's consumed runtime bundles/assets can have configuration words in
  // generated filenames; arbitrary JSON or source config inside .vite cannot.
  if (/^apps\/desktop\/\.vite\/(?:build\/(?:main|preload)\.cjs|renderer\/index\.html|renderer\/assets\/[\w.-]+\.(?:js|css|png|svg|webp|woff2?))$/u.test(path)) return false;
  return /(?:^|\/)(?:settings\.json|\.npmrc|\.config(?:\/|$)|\.env(?:\.|$))/iu.test(path) ||
    /(?:^|\/)(?:config|configuration|credentials|secrets|private|hosts?)(?:\/|[.-])/iu.test(path) ||
    /(?:^|[./-])(?:local|machine|user)(?:[.-])[^/]*\.(?:json|ya?ml|toml|ini|conf|[cm]?ts|[cm]?js)$/iu.test(path) ||
    /(?:^|[./_-])(?:config|configuration)(?:[./_-]|$)/iu.test(path) ||
    /(?:^|\/)(?:server|runtime|deployment)(?:[._-][^/]+)?\.(?:json|ya?ml|toml|ini|conf)$/iu.test(path) ||
    /(?:^|\/)(?:tsconfig|package)(?:[._-][^/]+)?\.json$/iu.test(path);
}

function forbiddenPath(path: string, tracked = false): boolean {
  return forbiddenDesktopPath(path, tracked) ||
    path.startsWith(".local-docs/") ||
    /(?:^|\/)\.env$/u.test(path) ||
    /\.(?:pem|key|p12|sqlite|db|tar|zip)$/u.test(path);
}

function isIgnoredDesktopIdentityPath(path: string): boolean {
  // Read ignored text/config candidates only inside the desktop boundary.
  // Distributable/archive contents are not configuration candidates.
  return path.startsWith("apps/desktop/") &&
    forbiddenDesktopPath(path, false) &&
    !/\.(?:app|dmg|asar|icns)(?:\/|$)/iu.test(path);
}

async function repositoryPaths(cwd: string): Promise<{ paths: string[]; tracked: Set<string>; publicPaths: string[]; identityPaths: string[] }> {
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
    identityPaths: [...tracked, ...visible, ...ignored.filter(isIgnoredDesktopIdentityPath)],
  };
}

async function fileBoundaryViolations(cwd: string): Promise<string[]> {
  const { paths, tracked } = await repositoryPaths(cwd);
  const violations: string[] = [];
  for (const path of paths) {
    if (!forbiddenPath(path, tracked.has(path))) continue;
    // Permit only the approved committed tooling file, byte for byte.
    if (path === "apps/desktop/.npmrc" && tracked.has(path) &&
      isApprovedDesktopTooling(await readFile(join(cwd, path), "utf8"))) continue;
    violations.push(path);
  }
  return violations;
}

async function privateIdentityViolations(cwd: string): Promise<string[]> {
  const { identityPaths: paths } = await repositoryPaths(cwd);
  const violations: string[] = [];

  for (const path of paths) {
    if (path === "scripts/public-boundary.test.ts") continue;
    const content = await readFile(`${cwd}/${path}`, "utf8");
    if (/remote-station|\/srv\/mi-estacion|\/home\/franmb|FranMBeron/iu.test(content)) {
      violations.push(path);
    }
  }

  return violations;
}

function productionSource(path: string): boolean {
  return /\.[cm]?[jt]sx?$/u.test(path) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) &&
    !/(?:^|\/)(?:__tests__|tests?|testing)(?:\/|$)/u.test(path);
}

function importedSpecifiers(path: string, content: string): string[] {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || requireCall) specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function stripSourceExtension(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/u, "");
}

function importsTestingTarget(
  sourcePath: string,
  specifier: string,
  target: string,
  cwd: string,
): boolean {
  const normalizedSpecifier = stripSourceExtension(specifier);
  if (normalizedSpecifier === target || normalizedSpecifier.startsWith(`${target}/`)) return true;

  const testingMarker = "/testing/";
  const markerIndex = target.indexOf(testingMarker);
  if (markerIndex >= 0) {
    const packageName = target.slice(0, markerIndex);
    const testingPath = target.slice(markerIndex + 1);
    const workspaceAlias = `${packageName}/src/${testingPath}`;
    if (normalizedSpecifier === workspaceAlias || normalizedSpecifier.startsWith(`${workspaceAlias}/`)) {
      return true;
    }
    if (specifier.startsWith(".")) {
      const resolvedImport = stripSourceExtension(resolve(cwd, dirname(sourcePath), specifier));
      const resolvedTarget = resolve(cwd, "packages/contracts/src", testingPath);
      return resolvedImport === resolvedTarget || resolvedImport.startsWith(`${resolvedTarget}/`);
    }
  }
  return false;
}

async function findProductionImports(target: string, cwd = repositoryRoot): Promise<string[]> {
  const { publicPaths } = await repositoryPaths(cwd);
  const violations: string[] = [];
  for (const path of publicPaths) {
    if (!productionSource(path)) continue;
    const content = await readFile(join(cwd, path), "utf8");
    if (importedSpecifiers(path, content).some((specifier) =>
      importsTestingTarget(path, specifier, target, cwd))) {
      violations.push(path);
    }
  }
  return violations.sort();
}

describe("desktop file boundary policy", () => {
  it.each(["visible", "ignored"])("scans private identity in untracked desktop tooling: %s", async (state) => {
    const root = await mkdtemp(join(tmpdir(), "desktop-identity-"));
    try {
      await exec("git", ["init", "--quiet", root]);
      await mkdir(join(root, "apps/desktop"), { recursive: true });
      if (state === "ignored") await writeFile(join(root, ".gitignore"), "apps/desktop/.npmrc\n");
      await writeFile(join(root, "apps/desktop/.npmrc"),
        "# Private identity: remote-station\nhoist-pattern[]=*\n");
      const inventory = await repositoryPaths(root);
      expect(await fileBoundaryViolations(root)).toContain("apps/desktop/.npmrc");
      expect(inventory.identityPaths).toContain("apps/desktop/.npmrc");
      expect(await privateIdentityViolations(root)).toContain("apps/desktop/.npmrc");
      expect(inventory.tracked.has("apps/desktop/.npmrc")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes ignored forbidden host configs in the identity scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-identity-"));
    try {
      await exec("git", ["init", "--quiet", root]);
      await mkdir(join(root, "apps/desktop"), { recursive: true });
      await writeFile(join(root, ".gitignore"), "apps/desktop/*.config.json\n");
      for (const name of ["server.config.json", "runtime.config.json", "deployment.config.json"]) {
        await writeFile(join(root, "apps/desktop", name), '{"serverUrl":"https://remote-station.invalid"}');
      }
      const expected = [
        "apps/desktop/server.config.json", "apps/desktop/runtime.config.json", "apps/desktop/deployment.config.json",
      ];
      const inventory = await repositoryPaths(root);
      expect(await fileBoundaryViolations(root)).toEqual(expect.arrayContaining(expected));
      expect(inventory.publicPaths).not.toEqual(expect.arrayContaining(expected));
      expect(inventory.identityPaths).toEqual(expect.arrayContaining(expected));
      expect(await privateIdentityViolations(root)).toEqual(expect.arrayContaining(expected));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes ignored output, archives, generated bundles and unrelated private trees from identity scanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-identity-"));
    try {
      await exec("git", ["init", "--quiet", root]);
      await writeFile(join(root, ".gitignore"), "apps/desktop/out/\napps/desktop/.vite/\napps/desktop/config/\nprivate-data/\n");
      const excluded = [
        "apps/desktop/out/server.config.json",
        "apps/desktop/out/release.app/Contents/Info.plist",
        "apps/desktop/out/resources/app.asar",
        "apps/desktop/.vite/build/main.cjs",
        "apps/desktop/.vite/renderer/assets/runtime.config-hash.js",
        "apps/desktop/config/runtime.asar",
        "private-data/server.config.json",
      ];
      for (const path of excluded) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), "remote-station");
      }
      const inventory = await repositoryPaths(root);
      for (const path of excluded) expect(inventory.identityPaths).not.toContain(path);
      expect(await privateIdentityViolations(root)).toEqual([]);
      expect(await fileBoundaryViolations(root)).not.toContain("apps/desktop/out/server.config.json");
      expect(await fileBoundaryViolations(root)).not.toContain("apps/desktop/.vite/renderer/assets/runtime.config-hash.js");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only exact sanitized pnpm tooling content", () => {
    expect(isApprovedDesktopTooling("# Declare pnpm's default explicitly for Electron Forge's package-manager check.\nhoist-pattern[]=*\n")).toBe(true);
    expect(isApprovedDesktopTooling("# Private origin https://private.example.test\nhoist-pattern[]=*\n")).toBe(false);
    expect(isApprovedDesktopTooling("hoist-pattern[]=*\n")).toBe(false);
    expect(isApprovedDesktopTooling("hoist-pattern[]=*\nregistry=https://registry.example.test\n")).toBe(false);
    expect(isApprovedDesktopTooling("hoist-pattern[]=*\nstore-dir=/tmp/private-store\n")).toBe(false);
  });

  it.each(["tracked", "visible", "ignored"])("rejects a private tooling comment in a %s file", async (state) => {
    const root = await mkdtemp(join(tmpdir(), "desktop-tooling-"));
    try {
      await exec("git", ["init", "--quiet", root]);
      await mkdir(join(root, "apps/desktop"), { recursive: true });
      if (state === "ignored") await writeFile(join(root, ".gitignore"), "apps/desktop/.npmrc\n");
      await writeFile(join(root, "apps/desktop/.npmrc"),
        "# Private origin https://private.example.test\nhoist-pattern[]=*\n");
      if (state === "tracked") await exec("git", ["add", "apps/desktop/.npmrc"], { cwd: root });
      expect(await fileBoundaryViolations(root)).toContain("apps/desktop/.npmrc");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["tracked", "visible", "ignored"])("allows exact tooling only when tracked: %s", async (state) => {
    const root = await mkdtemp(join(tmpdir(), "desktop-tooling-"));
    try {
      await exec("git", ["init", "--quiet", root]);
      await mkdir(join(root, "apps/desktop"), { recursive: true });
      if (state === "ignored") await writeFile(join(root, ".gitignore"), "apps/desktop/.npmrc\n");
      await writeFile(join(root, "apps/desktop/.npmrc"),
        "# Declare pnpm's default explicitly for Electron Forge's package-manager check.\nhoist-pattern[]=*\n");
      if (state === "tracked") await exec("git", ["add", "apps/desktop/.npmrc"], { cwd: root });
      expect(await fileBoundaryViolations(root)).toEqual(
        state === "tracked" ? [] : ["apps/desktop/.npmrc"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["visible", "ignored"])("rejects host config filenames even with a generic origin: %s", async (state) => {
    const root = await mkdtemp(join(tmpdir(), "desktop-config-"));
    try {
      await exec("git", ["init", "--quiet", root]);
      await mkdir(join(root, "apps/desktop"), { recursive: true });
      if (state === "ignored") await writeFile(join(root, ".gitignore"), "apps/desktop/*\n");
      for (const name of ["server.config.json", "runtime.config.json", "deployment.config.json", "custom.config.json",
        "server-config.json", "runtime_settings.yaml", "deployment-settings.toml"]) {
        await writeFile(join(root, "apps/desktop", name), '{"serverUrl":"https://workspace.example.test"}');
      }
      expect(await fileBoundaryViolations(root)).toEqual(expect.arrayContaining([
        "apps/desktop/server.config.json", "apps/desktop/runtime.config.json",
        "apps/desktop/deployment.config.json", "apps/desktop/custom.config.json",
        "apps/desktop/server-config.json", "apps/desktop/runtime_settings.yaml", "apps/desktop/deployment-settings.toml",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("permits only explicit generic source configuration and generated runtime paths", () => {
    for (const path of ["apps/desktop/forge.config.ts", "apps/desktop/vite.main.config.ts",
      "apps/desktop/vite.preload.config.ts", "apps/desktop/vite.renderer.config.ts",
      "apps/desktop/tsconfig.json", "apps/desktop/package.json",
      "apps/desktop/.vite/build/main.cjs", "apps/desktop/.vite/build/preload.cjs",
      "apps/desktop/.vite/renderer/index.html", "apps/desktop/.vite/renderer/assets/runtime.config-hash.js",
      "apps/desktop/out/server.config.json", "apps/desktop/out/release.dmg"]) {
      expect(forbiddenPath(path), path).toBe(false);
    }
    for (const path of ["apps/desktop/src/forge.config.ts", "apps/desktop/custom.config.ts",
      "apps/desktop/server.json", "apps/desktop/runtime.yaml", "apps/desktop/deployment.toml",
      "apps/desktop/tsconfig.custom.json", "apps/desktop/src/tsconfig.json", "apps/desktop/src/package.json"]) {
      expect(forbiddenPath(path), path).toBe(true);
    }
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
    expect(await fileBoundaryViolations(repositoryRoot)).toEqual([]);
  });

  it("contains no private host or previous-install identity", async () => {
    expect(await privateIdentityViolations(repositoryRoot)).toEqual([]);
  });

  it("keeps the testing subpath out of production imports", async () => {
    const violations = await findProductionImports(
      "@personal-intelligence-hub/contracts/testing/connectors",
    );
    expect(violations).toEqual([]);
  });

  it("detects every forbidden testing import form and workspace source alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "production-imports-"));
    try {
      await exec("git", ["init", "--quiet", root]);
      const fixtures = {
        "apps/api/src/static.ts":
          'import { sourceStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";\n',
        "apps/api/src/dynamic.ts":
          'export const fixture = import("@personal-intelligence-hub/contracts/testing/connectors");\n',
        "apps/api/src/require.cjs":
          'const fixture = require("@personal-intelligence-hub/contracts/testing/connectors");\n',
        "apps/web/src/package-alias.ts":
          'import "@personal-intelligence-hub/contracts/src/testing/connectors.js";\n',
        "apps/web/src/alias.ts":
          'export { sourceStatusFixture } from "../../../packages/contracts/src/testing/connectors.js";\n',
      };
      for (const [path, content] of Object.entries(fixtures)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), content);
      }

      expect(await findProductionImports(
        "@personal-intelligence-hub/contracts/testing/connectors",
        root,
      )).toEqual(Object.keys(fixtures).sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
