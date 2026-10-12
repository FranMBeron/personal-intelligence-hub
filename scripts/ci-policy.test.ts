import { glob, readFile } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
];

const collectUses = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(collectUses);
  if (value === null || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.uses === "string" ? [record.uses] : []),
    ...Object.values(record).flatMap(collectUses),
  ];
};

type Workflow = { jobs: Record<string, { "runs-on": string; steps: Record<string, unknown>[]; env?: Record<string, string>; if?: string | boolean; "continue-on-error"?: string | boolean }> };
type PackageScripts = { name: string; path: string; scripts: Record<string, string> };

function matchesPackageName(value: string, pattern: string): boolean {
  // pnpm's name selector * includes the slash in a scoped package name;
  // workspace directory globs use path semantics separately below.
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function executedCommands(run: string): string[] {
  return run.split(/\n|&&|\|\||[;|]/u).map((line) => line.trim()).filter(Boolean);
}

function invokedScriptCommands(
  run: string,
  scripts: Record<string, string>,
  packages: PackageScripts[],
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const root: PackageScripts = { name: "root", path: ".", scripts };
  const visit = (source: string, current: PackageScripts): void => {
    for (const command of executedCommands(source)) {
      result.push(command);
      const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/gu)?.map((token) => token.replace(/^["']|["']$/gu, "")) ?? [];
      let index = tokens.indexOf("pnpm");
      if (index < 0) continue;
      index += 1;
      let recursive = false;
      let directory: string | undefined;
      const filters: string[] = [];
      while (tokens[index]?.startsWith("-")) {
        const flag = tokens[index++]!;
        if (["-r", "--recursive"].includes(flag)) recursive = true;
        else if (["-C", "--dir"].includes(flag)) directory = tokens[index++];
        else if (flag.startsWith("--dir=")) directory = flag.slice(6);
        else if (flag === "--filter") filters.push(tokens[index++] ?? "");
        else if (flag.startsWith("--filter=")) filters.push(flag.slice(9));
      }
      if (tokens[index] === "run") index += 1;
      const script = tokens[index];
      if (!script || ["exec", "install", "audit", "licenses"].includes(script)) continue;
      const selected = directory !== undefined ? packages.filter((pkg) => pkg.path === directory.replace(/^\.\//u, "")) :
        recursive || filters.length > 0 ? packages.filter((pkg) => {
          const matches = (filter: string) => matchesPackageName(pkg.name, filter) || matchesGlob(pkg.path, filter.replace(/^\.\//u, ""));
          const includes = filters.filter((filter) => !filter.startsWith("!"));
          return (includes.length === 0 || includes.some(matches)) &&
            !filters.some((filter) => filter.startsWith("!") && matches(filter.slice(1)));
        }) : [current];
      for (const pkg of selected) {
        const body = pkg.scripts[script];
        const key = `${pkg.path}:${script}`;
        if (body === undefined || visited.has(key)) continue;
        visited.add(key);
        visit(body, pkg);
      }
    }
  };
  visit(run, root);
  return result;
}

function desktopPolicyViolations(
  workflow: Workflow,
  scripts: Record<string, string>,
  workspacePackages: string[],
  packages: PackageScripts[] = [],
): string[] {
  const violations: string[] = [];
  const jobs = Object.values(workflow.jobs);
  if (/\b(?:APPLE_ID|APPLE_PASSWORD|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|CSC_LINK|CSC_KEY_PASSWORD)\b|(?:osxSign|osxNotarize)/iu.test(JSON.stringify(workflow))) {
    violations.push("CI must not reference Apple signing or notarization credentials");
  }
  const mandatory = (value: { if?: unknown; "continue-on-error"?: unknown }) =>
    (value.if === undefined || value.if === true) &&
    (value["continue-on-error"] === undefined || value["continue-on-error"] === false);
  const required = ["pnpm install --frozen-lockfile", "pnpm lint", "pnpm typecheck", "pnpm test", "pnpm build"];
  // A required gate must be a direct blocking command. Shell composition can
  // suppress failure or short-circuit execution; reject it conservatively.
  const commands = (steps: Record<string, unknown>[]) => steps.filter(mandatory)
    .flatMap((step) => typeof step.run === "string" && required.includes(step.run.trim()) ? [step.run.trim()] : []);
  if (!jobs.some((job) => job["runs-on"].startsWith("ubuntu-") && mandatory(job) &&
    required.every((command) => commands(job.steps).includes(command)))) {
    violations.push("Ubuntu verification must install frozen dependencies and run every source gate");
  }
  for (const gate of ["build", "typecheck", "test"]) {
    const recursiveCommand = `pnpm -r --if-present ${gate}`;
    const allowedCommands = gate === "typecheck" ? [recursiveCommand, "tsc -p tsconfig.scripts.json --noEmit"] : [recursiveCommand];
    // Root scripts get the same conservative treatment as workflow steps.
    // Typecheck may compose its two known blocking checks using AND only.
    const scriptCommands = scripts[gate]?.trim().split("&&").map((command) => command.trim()) ?? [];
    if (!scriptCommands.includes(recursiveCommand) ||
      !scriptCommands.every((command) => allowedCommands.includes(command))) {
      violations.push(`${gate} must include desktop through recursive workspace execution`);
    }
  }
  if (scripts.lint?.trim() !== "eslint . --max-warnings=0") {
    violations.push("lint must cover all repository sources including desktop");
  }
  if (!workspacePackages.some((pattern) => !pattern.startsWith("!") && matchesGlob("apps/desktop", pattern)) ||
    workspacePackages.some((pattern) => pattern.startsWith("!") && matchesGlob("apps/desktop", pattern.slice(1)))) {
    violations.push("desktop must be part of the pnpm workspace");
  }
  for (const job of jobs) {
    for (const step of job.steps) {
      const run = invokedScriptCommands(typeof step.run === "string" ? step.run : "", scripts, packages).join("\n");
      const uses = typeof step.uses === "string" ? step.uses : "";
      if (/\b(?:desktop:make|make:mac)\b|electron-forge\s+make\b/u.test(run)) {
        violations.push("CI must not make a macOS installer");
      }
      if (/\b(?:npm|pnpm)\s+publish\b|electron-forge\s+publish\b|gh\s+release\b/u.test(run) ||
        /(?:action-gh-release|release-action|electron-builder-action)@/u.test(uses) ||
        (/actions\/upload-artifact@/u.test(uses) && /desktop|\.dmg\b|\.app\b|apps\/desktop\/out/u.test(JSON.stringify(step.with ?? {})))) {
        violations.push("CI must not publish desktop artifacts");
      }
    }
  }
  return violations;
}

const compliantWorkflow = (): Workflow => ({ jobs: { verify: {
  "runs-on": "ubuntu-latest",
  steps: ["pnpm install --frozen-lockfile", "pnpm lint", "pnpm typecheck", "pnpm test", "pnpm build"].map((run) => ({ run })),
} } });
const workspaceScripts = {
  lint: "eslint . --max-warnings=0",
  typecheck: "tsc -p tsconfig.scripts.json --noEmit && pnpm -r --if-present typecheck",
  test: "pnpm -r --if-present test",
  build: "pnpm -r --if-present build",
};

describe("desktop CI source-only policy", () => {
  it.each(["true || pnpm -r --if-present test", "pnpm -r --if-present test || true", "exit 0; pnpm -r --if-present test"])("rejects a root test script that bypasses its recursive gate: %s", (test) => {
    expect(desktopPolicyViolations(compliantWorkflow(), { ...workspaceScripts, test }, ["apps/*"]))
      .toContain("test must include desktop through recursive workspace execution");
  });

  it.each(["build", "typecheck"])("rejects shell failure masking in root %s", (gate) => {
    expect(desktopPolicyViolations(compliantWorkflow(), { ...workspaceScripts, [gate]: `pnpm -r --if-present ${gate} || true` }, ["apps/*"]))
      .toContain(`${gate} must include desktop through recursive workspace execution`);
  });

  it.each(["true || eslint . --max-warnings=0", "eslint . --max-warnings=0 || true", "exit 0; eslint . --max-warnings=0"])("rejects a root lint script that bypasses source checking: %s", (lint) => {
    expect(desktopPolicyViolations(compliantWorkflow(), { ...workspaceScripts, lint }, ["apps/*"]))
      .toContain("lint must cover all repository sources including desktop");
  });

  it.each(["pnpm test || true", "true || pnpm test", "pnpm test | true", "exit 0\npnpm test", "if false; then\npnpm test\nfi"])("rejects a gate hidden by shell control flow: %s", (run) => {
    const workflow = compliantWorkflow();
    workflow.jobs.verify!.steps.find((step) => step.run === "pnpm test")!.run = run;
    expect(desktopPolicyViolations(workflow, workspaceScripts, ["apps/*"]))
      .toContain("Ubuntu verification must install frozen dependencies and run every source gate");
  });

  it.each(["!apps/des?top", "!apps/[d]esktop"])("honors a pnpm glob desktop exclusion: %s", (exclusion) => {
    expect(desktopPolicyViolations(compliantWorkflow(), workspaceScripts, ["apps/*", exclusion]))
      .toContain("desktop must be part of the pnpm workspace");
  });

  it.each(["if", "continue-on-error"] as const)("rejects a verification job with %s", (key) => {
    const workflow = compliantWorkflow();
    workflow.jobs.verify![key] = key === "if" ? "${{ github.event_name == 'push' }}" : true;
    expect(desktopPolicyViolations(workflow, workspaceScripts, ["apps/*"]))
      .toContain("Ubuntu verification must install frozen dependencies and run every source gate");
  });

  it.each(["if", "continue-on-error"])("rejects a required source gate with %s", (key) => {
    const workflow = compliantWorkflow();
    workflow.jobs.verify!.steps.find((step) => step.run === "pnpm test")![key] = key === "if" ? false : true;
    expect(desktopPolicyViolations(workflow, workspaceScripts, ["apps/*"]))
      .toContain("Ubuntu verification must install frozen dependencies and run every source gate");
  });

  it.each(["pnpm desktop:make", "pnpm run desktop:make", "pnpm exec electron-forge publish"])("rejects an invoked root script that hides %s", (hidden) => {
    const scripts = { ...workspaceScripts, build: "pnpm -r --if-present build && pnpm run bundle", bundle: "pnpm run deliver", deliver: hidden };
    expect(desktopPolicyViolations(compliantWorkflow(), scripts, ["apps/*"]))
      .toContain(hidden.includes("publish") ? "CI must not publish desktop artifacts" : "CI must not make a macOS installer");
  });

  it.each(["electron-forge make --platform=darwin", "electron-forge publish"])("rejects an invoked package script that hides %s", (hidden) => {
    const packages = [{ name: "@personal-intelligence-hub/desktop", path: "apps/desktop", scripts: { build: "pnpm run release", release: hidden } }];
    expect(desktopPolicyViolations(compliantWorkflow(), workspaceScripts, ["apps/*"], packages))
      .toContain(hidden.includes("publish") ? "CI must not publish desktop artifacts" : "CI must not make a macOS installer");
  });

  it.each(["pnpm --filter @personal-intelligence-hub/desktop run release", "pnpm -C apps/desktop release", 'pnpm --filter "*" run release'])("follows targeted package script invocation: %s", (run) => {
    const workflow = compliantWorkflow();
    workflow.jobs.verify!.steps.push({ run });
    const packages = [{ name: "@personal-intelligence-hub/desktop", path: "apps/desktop", scripts: { release: "electron-forge publish" } }];
    expect(desktopPolicyViolations(workflow, workspaceScripts, ["apps/*"], packages))
      .toContain("CI must not publish desktop artifacts");
  });

  it("rejects a workspace exclusion that removes desktop after apps/*", () => {
    expect(desktopPolicyViolations(compliantWorkflow(), workspaceScripts, ["apps/*", "!apps/desktop"]))
      .toContain("desktop must be part of the pnpm workspace");
  });

  it("terminates cyclic script traversal without scanning uninvoked publishing scripts", () => {
    const scripts = { ...workspaceScripts, cycle: "pnpm cycle", release: "electron-forge publish" };
    const workflow = compliantWorkflow();
    workflow.jobs.verify!.steps.push({ run: "pnpm cycle" });
    expect(desktopPolicyViolations(workflow, scripts, ["apps/*"])).toEqual([]);
  });

  it("builds and security-scans the connectors release bundle with a pinned base image", async () => {
    const workflow = parse(await readFile(`${repositoryRoot}/.github/workflows/ci.yml`, "utf8")) as Workflow;
    const job = workflow.jobs["container-security"] as unknown as {
      strategy: { matrix: { include: { application: string; dockerfile: string; image: string; build_args?: string; target?: string }[] } };
      steps: Record<string, unknown>[];
    };
    const connector = job.strategy.matrix.include.find((entry) => entry.application === "connectors");
    expect(connector).toBeDefined();
    expect(connector).toMatchObject({
      dockerfile: "connectors-build.Dockerfile",
      image: "pih-connectors-build",
      build_args: "--build-arg NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402",
      target: "--target build",
    });
    expect(job.steps.some((step) => typeof step.uses === "string" && step.uses.startsWith("anchore/sbom-action@"))).toBe(true);
    expect(job.steps.some((step) => typeof step.uses === "string" && step.uses.startsWith("anchore/scan-action@"))).toBe(true);
  });

  it("verifies the actual Ubuntu workflow and workspace script coverage", async () => {
    const workflow = parse(await readFile(`${repositoryRoot}/.github/workflows/ci.yml`, "utf8")) as Workflow;
    const manifest = JSON.parse(await readFile(`${repositoryRoot}/package.json`, "utf8")) as { scripts: Record<string, string> };
    const workspace = parse(await readFile(`${repositoryRoot}/pnpm-workspace.yaml`, "utf8")) as { packages: string[] };
    const packages: PackageScripts[] = [];
    for await (const path of glob(workspace.packages.filter((pattern) => !pattern.startsWith("!")).map((pattern) => `${pattern}/package.json`), { cwd: repositoryRoot })) {
      const pkg = JSON.parse(await readFile(`${repositoryRoot}/${path}`, "utf8")) as { name: string; scripts?: Record<string, string> };
      packages.push({ name: pkg.name, path: path.replace(/\/package\.json$/u, ""), scripts: pkg.scripts ?? {} });
    }
    expect(desktopPolicyViolations(workflow, manifest.scripts, workspace.packages, packages)).toEqual([]);
  });

  it.each(["pnpm install --frozen-lockfile", "pnpm lint", "pnpm typecheck", "pnpm test", "pnpm build"])("rejects a missing source gate: %s", (missing) => {
    const workflow = compliantWorkflow();
    workflow.jobs.verify!.steps = workflow.jobs.verify!.steps.filter((step) => step.run !== missing);
    expect(desktopPolicyViolations(workflow, workspaceScripts, ["apps/*"])).toContain("Ubuntu verification must install frozen dependencies and run every source gate");
  });

  it.each(["build", "typecheck", "test"])("rejects %s scripts that omit desktop workspace execution", (gate) => {
    expect(desktopPolicyViolations(compliantWorkflow(), { ...workspaceScripts, [gate]: "pnpm --filter @personal-intelligence-hub/web build" }, ["apps/*"]))
      .toContain(`${gate} must include desktop through recursive workspace execution`);
  });

  it("rejects lint or workspace configuration that excludes desktop", () => {
    expect(desktopPolicyViolations(compliantWorkflow(), { ...workspaceScripts, lint: "eslint apps/web" }, ["packages/*"]))
      .toEqual(["lint must cover all repository sources including desktop", "desktop must be part of the pnpm workspace"]);
  });

  it.each(["pnpm desktop:make", "pnpm --filter @personal-intelligence-hub/desktop make:mac", "pnpm exec electron-forge make --platform=darwin"])("rejects macOS packaging in CI: %s", (run) => {
    const workflow = compliantWorkflow();
    workflow.jobs.verify!.steps.push({ run });
    expect(desktopPolicyViolations(workflow, workspaceScripts, ["apps/*"])).toContain("CI must not make a macOS installer");
  });

  it.each([
    { run: "pnpm publish" }, { run: "pnpm exec electron-forge publish" },
    { run: "gh release create nightly" }, { uses: "softprops/action-gh-release@fixture" },
    { uses: "actions/upload-artifact@fixture", with: { name: "desktop", path: "apps/desktop/out" } },
  ])("rejects publishing desktop artifacts: %j", (step) => {
    const workflow = compliantWorkflow();
    workflow.jobs.verify!.steps.push(step);
    expect(desktopPolicyViolations(workflow, workspaceScripts, ["apps/*"])).toContain("CI must not publish desktop artifacts");
  });

  it.each(["APPLE_ID", "APPLE_PASSWORD", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "CSC_LINK", "CSC_KEY_PASSWORD"])("rejects Apple credentials: %s", (credential) => {
    const workflow = compliantWorkflow();
    workflow.jobs.verify!.steps.push({ run: "pnpm build", env: { [credential]: "${{ secrets.SIGNING_VALUE }}" } });
    expect(desktopPolicyViolations(workflow, workspaceScripts, ["apps/*"])).toContain("CI must not reference Apple signing or notarization credentials");
  });

  it("allows existing non-desktop license and SBOM artifact uploads", () => {
    const workflow = compliantWorkflow();
    workflow.jobs.verify!.steps.push({ uses: "actions/upload-artifact@fixture", with: { name: "third-party-licenses", path: "third-party-licenses.json" } });
    expect(desktopPolicyViolations(workflow, workspaceScripts, ["apps/*"])).toEqual([]);
  });

  it("rejects Apple credentials inherited from job environment", () => {
    const workflow = compliantWorkflow();
    workflow.jobs.verify!.env = { APPLE_TEAM_ID: "${{ secrets.SIGNING_TEAM }}" };
    expect(desktopPolicyViolations(workflow, workspaceScripts, ["apps/*"])).toContain("CI must not reference Apple signing or notarization credentials");
  });
});

describe("CI security policy", () => {
  it("pins every external action to an immutable commit SHA", async () => {
    for (const workflowPath of workflowPaths) {
      const workflow = parse(
        await readFile(`${repositoryRoot}/${workflowPath}`, "utf8"),
      ) as unknown;
      const actions = collectUses(workflow).filter((uses) => !uses.startsWith("./"));
      expect(actions.length, `${workflowPath} must use actions`).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action, `${workflowPath}: ${action}`).toMatch(/^[^@]+@[a-f0-9]{40}$/u);
      }
    }
  });

  it("gates release code with E2E, dependency, container and history checks", async () => {
    const ci = await readFile(
      `${repositoryRoot}/.github/workflows/ci.yml`,
      "utf8",
    );

    expect(ci).toContain("pnpm -C apps/web test:e2e");
    expect(ci).toContain("pnpm audit --audit-level moderate");
    expect(ci).toContain("pnpm verify:secrets:history");
    expect(ci).toContain("anchore/sbom-action@");
    expect(ci).toContain("anchore/scan-action@");
    expect(ci).toContain("pnpm test:docker-policy");
  });
});
