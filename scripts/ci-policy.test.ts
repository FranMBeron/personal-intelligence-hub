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
