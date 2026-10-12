import swagger from "@fastify/swagger";
import {
  ApiProblemSchema,
  AuditEventSchema,
  BoardSchema,
  BoardSnapshotSchema,
  CardSchema,
  CardTagMembershipSchema,
  CompensateAuditEventBodySchema,
  CreateBoardBodySchema,
  CreateCardBodySchema,
  CreateRelationBodySchema,
  CreateTaskBodySchema,
  PatchCardBodySchema,
  PatchTaskBodySchema,
  RelationSchema,
  OutboxEventSchema,
  SnapshotSchema,
  TaskSchema,
  createPageSchema,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { z, type ZodType } from "zod";

const asJsonSchema = (id: string, schema: ZodType) => {
  const generated = z.toJSONSchema(schema, { target: "draft-7" });
  const { $schema: _dialect, ...jsonSchema } = generated;
  return { $id: id, ...jsonSchema };
};

const registerSchemas = (app: FastifyInstance) => {
  const compensationResult = z.union([
    BoardSnapshotSchema,
    CardSchema,
    CardTagMembershipSchema,
    RelationSchema,
    TaskSchema,
  ]);
  const schemas = [
    ["ApiProblem", ApiProblemSchema],
    ["Board", BoardSchema],
    ["BoardSnapshot", BoardSnapshotSchema],
    ["Card", CardSchema],
    ["CardTagMembership", CardTagMembershipSchema],
    ["Relation", RelationSchema],
    ["Task", TaskSchema],
    ["AuditEvent", AuditEventSchema],
    ["OutboxEvent", OutboxEventSchema],
    ["Snapshot", SnapshotSchema],
    ["BoardPage", createPageSchema(BoardSchema)],
    ["TaskPage", createPageSchema(TaskSchema)],
    ["AuditEventPage", createPageSchema(AuditEventSchema)],
    ["CompensationResult", compensationResult],
    ["CreateBoardBody", CreateBoardBodySchema],
    ["CreateCardBody", CreateCardBodySchema],
    ["PatchCardBody", PatchCardBodySchema],
    ["CreateRelationBody", CreateRelationBodySchema],
    ["CreateTaskBody", CreateTaskBodySchema],
    ["PatchTaskBody", PatchTaskBodySchema],
    ["CompensateAuditEventBody", CompensateAuditEventBodySchema],
    ["EmptyBody", z.object({}).strict()],
    ["HealthLive", z.object({ status: z.literal("ok") }).strict()],
    ["HealthReady", z.object({ status: z.literal("ready") }).strict()],
    [
      "PublicConfig",
      z
        .object({
          apiVersion: z.string(),
          productName: z.string(),
          oidcIssuer: z.string().optional(),
          oidcClientId: z.string().optional(),
          enabledUiCapabilities: z.array(z.string()),
        })
        .strict(),
    ],
  ] as const;
  for (const [id, schema] of schemas) {
    app.addSchema(asJsonSchema(id, schema));
  }
};

export const registerOpenApi = (app: FastifyInstance): void => {
  registerSchemas(app);
  void app.register(swagger, {
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, index) =>
        typeof json.$id === "string" ? json.$id : `def-${index}`,
    },
    transform: ({ schema, url }) => {
      if (schema === undefined) {
        return { schema, url };
      }
      const transformed = structuredClone(schema);
      const headers = transformed.headers;
      if (
        typeof headers === "object" &&
        headers !== null &&
        "properties" in headers &&
        typeof headers.properties === "object" &&
        headers.properties !== null
      ) {
        const properties = headers.properties as Record<string, unknown>;
        const names = {
          "idempotency-key": "Idempotency-Key",
          "if-match": "If-Match",
          "last-event-id": "Last-Event-ID",
          "x-origin-channel": "X-Origin-Channel",
        } as const;
        for (const [runtimeName, documentedName] of Object.entries(names)) {
          if (runtimeName in properties) {
            properties[documentedName] = properties[runtimeName];
            delete properties[runtimeName];
          }
        }
        const lastEventId = properties["Last-Event-ID"];
        if (typeof lastEventId === "object" && lastEventId !== null) {
          properties["Last-Event-ID"] = {
            ...lastEventId,
            pattern: "^(?:0|[1-9]\\d*)$",
          };
        }
        if ("required" in headers && Array.isArray(headers.required)) {
          headers.required = headers.required.map(
            (name) => names[name as keyof typeof names] ?? name,
          );
        }
        if (
          "If-Match" in properties &&
          "required" in headers &&
          Array.isArray(headers.required) &&
          !headers.required.includes("If-Match")
        ) {
          headers.required.push("If-Match");
        }
      }
      return { schema: transformed, url };
    },
    transformObject: (document) =>
      "openapiObject" in document
        ? {
            ...document.openapiObject,
            jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
          }
        : document.swaggerObject,
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Personal Intelligence Hub Second Brain API",
        version: "0.1.0",
      },
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
  });
};
