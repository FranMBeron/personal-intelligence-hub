import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parse } from "yaml";

import type { Principal } from "../packages/contracts/src/index.js";

import { HmacCursorCodec } from "../apps/api/src/adapters/cursors/hmac-cursor-codec.js";
import { buildApp } from "../apps/api/src/app.js";
import type { Authenticator } from "../apps/api/src/application/ports/authenticator.js";
import type { QueryPorts } from "../apps/api/src/application/ports/queries.js";
import type { UnitOfWork } from "../apps/api/src/application/ports/unit-of-work.js";
import { EventBus } from "../apps/api/src/events/event-bus.js";
import type { OutboxStore } from "../apps/api/src/events/outbox-dispatcher.js";

export type OpenApiDocument = Record<string, unknown> & {
  openapi?: unknown;
  jsonSchemaDialect?: unknown;
  info?: unknown;
  security?: unknown;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    securitySchemes?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
  };
};

type OpenApiOperation = {
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
};

const principal: Principal = {
  subject: "openapi-generator",
  actorId: "10000000-0000-4000-8000-000000000099",
  actorType: "service",
  scopes: ["second-brain:read", "second-brain:write", "second-brain:compensate"],
  allowedSources: ["test"],
};

class GeneratorAuthenticator implements Authenticator {
  readonly kind = "test" as const;
  async authenticate(): Promise<Principal> {
    return principal;
  }
}

const queries = {} as QueryPorts;
const unitOfWork = {} as UnitOfWork;
const outboxStore: OutboxStore = {
  retentionState: async () => ({ latestSequence: "0", lastExpiredSequence: null }),
  readAfter: async () => [],
  claimBatch: async () => [],
  markDispatched: async () => undefined,
  markFailed: async () => undefined,
};

export const generateOpenApiDocument = async (): Promise<OpenApiDocument> => {
  const app = buildApp({
    authenticator: new GeneratorAuthenticator(),
    cursorCodec: new HmacCursorCodec(
      "fictional-openapi-cursor-key-with-at-least-32-bytes",
    ),
    unitOfWork,
    queries,
    readinessCheck: async () => ({ status: "ready" }),
    clock: () => new Date("2026-09-16T12:00:00.000Z"),
    requestIdFactory: () => "20000000-0000-4000-8000-000000000099",
    publicConfig: {
      apiVersion: "v1",
      productName: "Personal Intelligence Hub",
      enabledUiCapabilities: ["second-brain"],
    },
    runtime: "test",
    logger: false,
    synchronization: { eventBus: new EventBus(), outboxStore },
  });
  try {
    await app.ready();
    return app.swagger() as OpenApiDocument;
  } finally {
    await app.close();
  }
};

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const nested = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

export const validateOpenApiContract = (
  document: OpenApiDocument,
  base: Record<string, unknown>,
): string[] => {
  const errors: string[] = [];
  if (document.openapi !== base.openapi) errors.push("OpenAPI dialect diverges from base.");
  if (document.jsonSchemaDialect !== base.jsonSchemaDialect) {
    errors.push("JSON Schema dialect diverges from base.");
  }
  for (const key of ["title", "version"]) {
    if (nested(document.info, key) !== nested(base.info, key)) {
      errors.push(`API ${key} diverges from base.`);
    }
  }
  if (!same(document.security, base.security)) errors.push("Global security diverges from base.");
  const generatedBearer = nested(
    document,
    "components",
    "securitySchemes",
    "bearerAuth",
  );
  const baseBearer = nested(base, "components", "securitySchemes", "bearerAuth");
  for (const key of ["type", "scheme", "bearerFormat"]) {
    if (nested(generatedBearer, key) !== nested(baseBearer, key)) {
      errors.push(`Bearer security ${key} diverges from base.`);
    }
  }
  const generatedCodes = nested(
    document,
    "components",
    "schemas",
    "ApiProblem",
    "properties",
    "code",
    "enum",
  );
  const baseCodes = nested(
    base,
    "components",
    "schemas",
    "ApiProblemCode",
    "enum",
  );
  if (!same(generatedCodes, baseCodes)) errors.push("Problem codes diverge from base.");
  for (const schema of ["ApiProblem", "OutboxEvent", "Snapshot"]) {
    if (nested(document, "components", "schemas", schema) === undefined) {
      errors.push(`Generated schema ${schema} is missing.`);
    }
  }

  const paths = document.paths ?? {};
  for (const path of ["/v1/events", "/v1/snapshot"]) {
    if (paths[path]?.get === undefined) errors.push(`Generated path ${path} is missing.`);
  }
  for (const [path, operations] of Object.entries(paths)) {
    if (!path.startsWith("/v1/")) continue;
    for (const [method, operation] of Object.entries(operations)) {
      if (!same(operation.security, [{ bearerAuth: [] }])) {
        errors.push(`${method.toUpperCase()} ${path} lacks bearer security.`);
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (
          Number(status) >= 400 &&
          response.content?.["application/problem+json"] === undefined
        ) {
          errors.push(`${method.toUpperCase()} ${path} ${status} is not a problem response.`);
        }
      }
      if (["post", "put", "patch", "delete"].includes(method)) {
        const names = operation.parameters?.map(({ name }) => name) ?? [];
        if (!names.includes("Idempotency-Key")) {
          errors.push(`${method.toUpperCase()} ${path} lacks Idempotency-Key.`);
        }
        if (!names.includes("X-Origin-Channel")) {
          errors.push(`${method.toUpperCase()} ${path} lacks X-Origin-Channel.`);
        }
      }
    }
  }
  return errors;
};

const serialize = (document: OpenApiDocument): string =>
  `${JSON.stringify(document, null, 2)}\n`;

const run = async (): Promise<void> => {
  const root = new URL("..", import.meta.url);
  const outputUrl = new URL("docs/api/openapi.json", root);
  const base = parse(
    await readFile(new URL("docs/api/openapi.base.yaml", root), "utf8"),
  ) as Record<string, unknown>;
  const document = await generateOpenApiDocument();
  const errors = validateOpenApiContract(document, base);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  const generated = serialize(document);
  if (process.argv.includes("--check")) {
    const committed = await readFile(outputUrl, "utf8");
    if (committed !== generated) {
      throw new Error("docs/api/openapi.json is stale; run pnpm openapi:generate.");
    }
    return;
  }
  await writeFile(outputUrl, generated, "utf8");
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
