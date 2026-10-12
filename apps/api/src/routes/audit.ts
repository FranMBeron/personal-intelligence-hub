import {
  CompensateAuditEventBodySchema,
  PaginationQuerySchema,
  UuidSchema,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  mutationContext,
  mutationRouteSchema,
  pageResponse,
  parse,
  readRouteSchema,
  sendMutation,
} from "./shared.js";

const eventParams = z.object({ eventId: UuidSchema }).strict();
const eventParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId"],
  properties: { eventId: { type: "string", format: "uuid" } },
} as const;

export const registerAuditRoutes = (app: FastifyInstance): void => {
  app.get(
    "/v1/audit-events",
    {
      config: { pihSecurity: { scopes: ["second-brain:read"] } },
      schema: readRouteSchema({ collection: true, responseRef: "AuditEventPage" }),
    },
    async (request) => {
      const query = parse(PaginationQuerySchema, request.query);
      const cursor =
        query.cursor === undefined
          ? undefined
          : request.server.pihDependencies.cursorCodec.decode(query.cursor, {
              route: "/v1/audit-events",
              filterHash: "none",
            });
      const page = await request.server.pihDependencies.queries.auditEvents.list({
        limit: query.limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      return pageResponse(request, page);
    },
  );

  app.post(
    "/v1/audit-events/:eventId/compensations",
    {
      config: {
        pihSecurity: {
          scopes: ["second-brain:write", "second-brain:compensate"],
          mutation: true,
          requireIfMatch: true,
        },
      },
      schema: {
        ...mutationRouteSchema({
          requireIfMatch: true,
          bodyRef: "CompensateAuditEventBody",
          responseRef: "CompensationResult",
          status: 201,
        }),
        params: eventParamsSchema,
      },
    },
    async (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      const body = parse(CompensateAuditEventBodySchema, request.body ?? {});
      const result = await request.server.pihDependencies.unitOfWork.execute(
        ({ mutations }) =>
          mutations.compensate(mutationContext(request), eventId, body),
      );
      return sendMutation(reply, result);
    },
  );
};
