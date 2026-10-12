import {
  CreateCardBodySchema,
  PatchCardBodySchema,
  UuidSchema,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { NotFoundError } from "../application/errors.js";
import {
  mutationContext,
  mutationRouteSchema,
  parse,
  readRouteSchema,
  sendMutation,
} from "./shared.js";

const cardParams = z.object({ cardId: UuidSchema }).strict();
const tagParams = z.object({ cardId: UuidSchema, tagId: UuidSchema }).strict();
const emptyBody = z.object({}).strict();
const cardParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cardId"],
  properties: { cardId: { type: "string", format: "uuid" } },
} as const;
const tagParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cardId", "tagId"],
  properties: {
    cardId: { type: "string", format: "uuid" },
    tagId: { type: "string", format: "uuid" },
  },
} as const;

export const registerCardRoutes = (app: FastifyInstance): void => {
  app.post(
    "/v1/cards",
    {
      config: { pihSecurity: { scopes: ["second-brain:write"], mutation: true } },
      schema: mutationRouteSchema({
        bodyRef: "CreateCardBody",
        responseRef: "Card",
        status: 201,
        location: true,
      }),
    },
    async (request, reply) => {
      const body = parse(CreateCardBodySchema, request.body);
      const result = await request.server.pihDependencies.unitOfWork.execute(
        ({ mutations }) => mutations.createCard(mutationContext(request), body),
      );
      return sendMutation(reply, result);
    },
  );

  app.get(
    "/v1/cards/:cardId",
    {
      config: { pihSecurity: { scopes: ["second-brain:read"] } },
      schema: {
        ...readRouteSchema({ responseRef: "Card", etag: true }),
        params: cardParamsSchema,
      },
    },
    async (request, reply) => {
      const { cardId } = parse(cardParams, request.params);
      const card = await request.server.pihDependencies.queries.cards.get(cardId);
      if (card === null) throw new NotFoundError();
      void reply.header("etag", `"card:${card.id}:${card.version}"`);
      return card;
    },
  );

  app.patch(
    "/v1/cards/:cardId",
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
          bodyRef: "PatchCardBody",
          responseRef: "Card",
        }),
        params: cardParamsSchema,
      },
    },
    async (request, reply) => {
      const { cardId } = parse(cardParams, request.params);
      const body = parse(PatchCardBodySchema, request.body);
      const result = await request.server.pihDependencies.unitOfWork.execute(
        ({ mutations }) => mutations.patchCard(mutationContext(request), cardId, body),
      );
      return sendMutation(reply, result);
    },
  );

  app.put(
    "/v1/cards/:cardId/tags/:tagId",
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
          bodyRef: "EmptyBody",
          responseRef: "CardTagMembership",
        }),
        params: tagParamsSchema,
      },
    },
    async (request, reply) => {
      const { cardId, tagId } = parse(tagParams, request.params);
      parse(emptyBody, request.body ?? {});
      const result = await request.server.pihDependencies.unitOfWork.execute(
        ({ mutations }) => mutations.addCardTag(mutationContext(request), cardId, tagId),
      );
      return sendMutation(reply, result);
    },
  );

  app.delete(
    "/v1/cards/:cardId/tags/:tagId",
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
          responseRef: "CardTagMembership",
        }),
        params: tagParamsSchema,
      },
    },
    async (request, reply) => {
      const { cardId, tagId } = parse(tagParams, request.params);
      const result = await request.server.pihDependencies.unitOfWork.execute(
        ({ mutations }) => mutations.removeCardTag(mutationContext(request), cardId, tagId),
      );
      return sendMutation(reply, result);
    },
  );
};
