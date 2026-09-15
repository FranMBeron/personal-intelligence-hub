import type { CursorPayload } from "@personal-intelligence-hub/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

import type { MutationResult } from "../application/ports/unit-of-work.js";

const problem = (description: string) => ({
  description,
  content: {
    "application/problem+json": { schema: { $ref: "ApiProblem#" } },
  },
});

const responseHeaders = (options: { etag?: boolean; location?: boolean } = {}) => ({
  "X-Request-Id": { type: "string", format: "uuid" },
  "Idempotency-Replayed": { type: "string", const: "true" },
  ...(options.etag ? { ETag: { type: "string" } } : {}),
  ...(options.location ? { Location: { type: "string" } } : {}),
});

const success = (
  description: string,
  schemaRef: string,
  options: { etag?: boolean; location?: boolean } = {},
) => ({
  description,
  type: "object",
  $ref: `${schemaRef}#`,
  headers: responseHeaders(options),
});

const commonProblems = {
  401: problem("Authentication required."),
  403: problem("The principal is not authorized."),
  404: problem("The resource was not found."),
} as const;

export const readRouteSchema = (
  options: {
    collection?: boolean;
    responseRef?: string;
    etag?: boolean;
  } = {},
) => ({
  security: [{ bearerAuth: [] }],
  ...(options.collection
    ? {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            cursor: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
      }
    : {}),
  response: {
    ...(options.responseRef === undefined
      ? {}
      : {
          200: success("Successful response.", options.responseRef, {
            ...(options.etag === undefined ? {} : { etag: options.etag }),
          }),
        }),
    ...commonProblems,
    422: problem("Request validation failed."),
  },
});

export const mutationRouteSchema = (
  options: {
    requireIfMatch?: boolean;
    bodyRef?: string;
    responseRef?: string;
    status?: 200 | 201;
    location?: boolean;
  } = {},
) => ({
  security: [{ bearerAuth: [] }],
  headers: {
    type: "object",
    additionalProperties: true,
    required: [
      "idempotency-key",
      "x-origin-channel",
      ...(options.requireIfMatch ? ["if-match"] : []),
    ],
    properties: {
      "idempotency-key": { type: "string", minLength: 8, maxLength: 255 },
      "x-origin-channel": {
        type: "string",
        enum: ["pih", "telegram", "hermes-web", "automation", "test"],
      },
      ...(options.requireIfMatch
        ? { "if-match": { type: "string", minLength: 1 } }
        : {}),
    },
  },
  ...(options.bodyRef === undefined
    ? {}
    : { body: { $ref: `${options.bodyRef}#` } }),
  response: {
    ...(options.responseRef === undefined
      ? {}
      : {
          [options.status ?? 200]: success(
            options.status === 201 ? "Resource created." : "Successful mutation.",
            options.responseRef,
            {
              etag: true,
              ...(options.location === undefined
                ? {}
                : { location: options.location }),
            },
          ),
        }),
    ...commonProblems,
    409: problem("The mutation conflicts with current state or idempotency history."),
    412: problem("The supplied resource version is stale."),
    422: problem("Request validation failed."),
    428: problem("If-Match is required."),
  },
});

export const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> =>
  schema.parse(value);

export const pageResponse = <T>(
  request: FastifyRequest,
  page: Readonly<{
    items: readonly T[];
    nextCursor: CursorPayload | null;
    hasNextPage: boolean;
  }>,
) => ({
  items: [...page.items],
  pageInfo: {
    nextCursor:
      page.nextCursor === null
        ? null
        : request.server.pihDependencies.cursorCodec.encode(page.nextCursor),
    hasNextPage: page.hasNextPage,
  },
});

export const sendMutation = <T>(
  reply: FastifyReply,
  result: MutationResult<T>,
): T => {
  void reply.status(result.status).headers({ ...result.headers });
  if (result.replayed) {
    void reply.header("idempotency-replayed", "true");
  }
  return result.body;
};

export const mutationContext = (request: FastifyRequest) => {
  if (request.mutationContext === undefined) {
    throw new Error("Mutation context was not installed.");
  }
  return request.mutationContext;
};
