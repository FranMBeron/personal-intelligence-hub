import { readFile } from "node:fs/promises";
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

type Workflow = { jobs: Record<string, { "runs-on": string; steps: Record<string, unknown>[]; env?: Record<string, string> }> };

function desktopPolicyViolations(
  workflow: Workflow,
  scripts: Record<string, string>,
  workspacePackages: string[],
): string[] {
  const violations: string[] = [];
  const jobs = Object.values(workflow.jobs);
  if (/\b(?:APPLE_ID|APPLE_PASSWORD|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|CSC_LINK|CSC_KEY_PASSWORD)\b|(?:osxSign|osxNotarize)/iu.test(JSON.stringify(workflow))) {
    violations.push("CI must not reference Apple signing or notarization credentials");
  }
  const commands = (steps: Record<string, unknown>[]) => steps
    .flatMap((step) => typeof step.run === "string" ? step.run.split(/\n|&&|;/u).map((line) => line.trim()) : []);
  const required = ["pnpm install --frozen-lockfile", "pnpm lint", "pnpm typecheck", "pnpm test", "pnpm build"];
  if (!jobs.some((job) => job["runs-on"].startsWith("ubuntu-") &&
    required.every((command) => commands(job.steps).includes(command)))) {
    violations.push("Ubuntu verification must install frozen dependencies and run every source gate");
  }
  for (const gate of ["build", "typecheck", "test"]) {
    if (!scripts[gate]?.includes(`pnpm -r --if-present ${gate}`)) {
      violations.push(`${gate} must include desktop through recursive workspace execution`);
    }
  }
  if (!/\beslint\s+\.(?:\s|$)/u.test(scripts.lint ?? "")) {
    violations.push("lint must cover all repository sources including desktop");
  }
  if (!workspacePackages.some((pattern) => ["apps/*", "apps/desktop"].includes(pattern))) {
    violations.push("desktop must be part of the pnpm workspace");
  }
  for (const job of jobs) {
    for (const step of job.steps) {
      const run = typeof step.run === "string" ? step.run : "";
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
  it("verifies the actual Ubuntu workflow and workspace script coverage", async () => {
    const workflow = parse(await readFile(`${repositoryRoot}/.github/workflows/ci.yml`, "utf8")) as Workflow;
    const manifest = JSON.parse(await readFile(`${repositoryRoot}/package.json`, "utf8")) as { scripts: Record<string, string> };
    const workspace = parse(await readFile(`${repositoryRoot}/pnpm-workspace.yaml`, "utf8")) as { packages: string[] };
    expect(desktopPolicyViolations(workflow, manifest.scripts, workspace.packages)).toEqual([]);
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
