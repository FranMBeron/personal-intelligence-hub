import { CreateRelationBodySchema, UuidSchema } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  mutationContext,
  mutationRouteSchema,
  parse,
  sendMutation,
} from "./shared.js";

const relationParams = z.object({ relationId: UuidSchema }).strict();
const relationParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["relationId"],
  properties: { relationId: { type: "string", format: "uuid" } },
} as const;

export const registerRelationRoutes = (app: FastifyInstance): void => {
  app.post(
    "/v1/relations",
    {
      config: { pihSecurity: { scopes: ["second-brain:write"], mutation: true } },
      schema: mutationRouteSchema({
        bodyRef: "CreateRelationBody",
        responseRef: "Relation",
        status: 201,
        location: true,
      }),
    },
    async (request, reply) => {
      const body = parse(CreateRelationBodySchema, request.body);
      const result = await request.server.pihDependencies.unitOfWork.execute(
        ({ mutations }) => mutations.createRelation(mutationContext(request), body),
      );
      return sendMutation(reply, result);
    },
  );

  app.delete(
    "/v1/relations/:relationId",
    {
      config: {
        pihSecurity: {
          scopes: ["second-brain:write"],
          mutation: true,
          requireIfMatch: true,
        },
      },
      schema: {
        ...mutationRouteSchema({
          requireIfMatch: true,
          responseRef: "Relation",
        }),
        params: relationParamsSchema,
      },
    },
    async (request, reply) => {
      const { relationId } = parse(relationParams, request.params);
      const result = await request.server.pihDependencies.unitOfWork.execute(
        ({ mutations }) =>
          mutations.archiveRelation(mutationContext(request), relationId),
      );
      return sendMutation(reply, result);
    },
  );
};
