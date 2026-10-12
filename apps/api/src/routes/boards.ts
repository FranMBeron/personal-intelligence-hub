import {
  CreateBoardBodySchema,
  PaginationQuerySchema,
  UuidSchema,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { NotFoundError } from "../application/errors.js";
import {
  mutationContext,
  mutationRouteSchema,
  pageResponse,
  parse,
  readRouteSchema,
  sendMutation,
} from "./shared.js";

const boardParams = z.object({ boardId: UuidSchema }).strict();
const paramsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["boardId"],
  properties: { boardId: { type: "string", format: "uuid" } },
} as const;

export const registerBoardRoutes = (app: FastifyInstance): void => {
  app.get(
    "/v1/boards",
    {
      config: { pihSecurity: { scopes: ["second-brain:read"] } },
      schema: readRouteSchema({ collection: true, responseRef: "BoardPage" }),
    },
    async (request) => {
      const query = parse(PaginationQuerySchema, request.query);
      const cursor =
        query.cursor === undefined
          ? undefined
          : request.server.pihDependencies.cursorCodec.decode(query.cursor, {
              route: "/v1/boards",
              filterHash: "none",
            });
      const page = await request.server.pihDependencies.queries.boards.list({
        limit: query.limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      return pageResponse(request, page);
    },
  );

  app.post(
    "/v1/boards",
    {
      config: { pihSecurity: { scopes: ["second-brain:write"], mutation: true } },
      schema: mutationRouteSchema({
        bodyRef: "CreateBoardBody",
        responseRef: "BoardSnapshot",
        status: 201,
        location: true,
      }),
    },
    async (request, reply) => {
      const body = parse(CreateBoardBodySchema, request.body);
      const result = await request.server.pihDependencies.unitOfWork.execute(
        ({ mutations }) => mutations.createBoard(mutationContext(request), body),
      );
      return sendMutation(reply, result);
    },
  );

  app.get(
    "/v1/boards/:boardId",
    {
      config: { pihSecurity: { scopes: ["second-brain:read"] } },
      schema: {
        ...readRouteSchema({ responseRef: "BoardSnapshot", etag: true }),
        params: paramsSchema,
      },
    },
    async (request, reply) => {
      const { boardId } = parse(boardParams, request.params);
      const board = await request.server.pihDependencies.queries.boards.get(boardId);
      if (board === null) throw new NotFoundError();
      void reply.header("etag", `"board:${board.id}:${board.version}"`);
      return board;
    },
  );
};
