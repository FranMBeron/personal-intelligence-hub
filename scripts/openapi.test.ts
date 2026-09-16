import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, test } from "vitest";

import {
  generateOpenApiDocument,
  validateOpenApiContract,
} from "./generate-openapi.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("generated public OpenAPI", () => {
  test("matches the frozen base and every tested HTTP behavior", async () => {
    const [document, baseText, committedText] = await Promise.all([
      generateOpenApiDocument(),
      readFile(`${root}/docs/api/openapi.base.yaml`, "utf8"),
      readFile(`${root}/docs/api/openapi.json`, "utf8"),
    ]);
    const base = parse(baseText) as Record<string, unknown>;

    expect(validateOpenApiContract(document, base)).toEqual([]);
    expect(document).toEqual(JSON.parse(committedText));

    const paths = document.paths as Record<
      string,
      Record<
        string,
        {
          security?: unknown;
          parameters?: Array<{
            name?: string;
            schema?: Record<string, unknown>;
          }>;
          responses?: Record<
            string,
            {
              content?: Record<string, unknown>;
              headers?: Record<string, unknown>;
            }
          >;
        }
      >
    >;
    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining(["/v1/events", "/v1/snapshot"]),
    );
    expect(paths["/v1/events"]?.get?.parameters?.map(({ name }) => name)).toContain(
      "Last-Event-ID",
    );
    expect(
      paths["/v1/events"]?.get?.parameters?.find(
        ({ name }) => name === "Last-Event-ID",
      )?.schema,
    ).toMatchObject({ pattern: "^(?:0|[1-9]\\d*)$" });
    expect(paths["/v1/events"]?.get?.responses?.["409"]?.headers).toHaveProperty(
      "Link",
    );

    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith("/v1/")) continue;
      for (const [method, operation] of Object.entries(operations)) {
        expect(operation.security).toEqual([{ bearerAuth: [] }]);
        expect(operation.responses).toHaveProperty("401");
        expect(operation.responses).toHaveProperty("403");
        for (const [status, response] of Object.entries(
          operation.responses ?? {},
        )) {
          if (Number(status) >= 400) {
            expect(response.content).toHaveProperty("application/problem+json");
            expect(response.headers).toHaveProperty("X-Request-Id");
          }
        }
        if (["post", "put", "patch", "delete"].includes(method)) {
          const names = operation.parameters?.map(({ name }) => name);
          expect(names).toEqual(
            expect.arrayContaining(["Idempotency-Key", "X-Origin-Channel"]),
          );
          expect(operation.responses).toHaveProperty("409");
          expect(operation.responses).toHaveProperty("422");
        }
      }
    }

    expect(paths["/v1/boards"]?.get?.responses?.["200"]?.headers).not.toHaveProperty(
      "Idempotency-Replayed",
    );
    expect(paths["/v1/boards"]?.post?.responses?.["201"]?.headers).toHaveProperty(
      "Idempotency-Replayed",
    );

    for (const path of ["/v1/boards", "/v1/tasks", "/v1/audit-events"]) {
      const names = paths[path]?.get?.parameters?.map(({ name }) => name);
      expect(names).toEqual(expect.arrayContaining(["limit", "cursor"]));
    }
    for (const [path, method] of [
      ["/v1/cards/{cardId}", "patch"],
      ["/v1/cards/{cardId}/tags/{tagId}", "put"],
      ["/v1/cards/{cardId}/tags/{tagId}", "delete"],
      ["/v1/relations", "post"],
      ["/v1/relations/{relationId}", "delete"],
      ["/v1/tasks/{taskId}", "patch"],
      ["/v1/audit-events/{eventId}/compensations", "post"],
    ] as const) {
      const operation = paths[path]?.[method];
      expect(operation?.parameters?.map(({ name }) => name)).toContain("If-Match");
      expect(operation?.responses).toHaveProperty("412");
      expect(operation?.responses).toHaveProperty("428");
    }
  });
});
