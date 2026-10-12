import {
  CreateTaskBodySchema,
  PaginationQuerySchema,
  PatchTaskBodySchema,
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

const taskParams = z.object({ taskId: UuidSchema }).strict();
const taskParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId"],
  properties: { taskId: { type: "string", format: "uuid" } },
} as const;

export const registerTaskRoutes = (app: FastifyInstance): void => {
  app.get(
    "/v1/tasks",
    {
      config: { pihSecurity: { scopes: ["second-brain:read"] } },
      schema: readRouteSchema({ collection: true, responseRef: "TaskPage" }),
    },
    async (request) => {
      const query = parse(PaginationQuerySchema, request.query);
      const cursor =
        query.cursor === undefined
          ? undefined
          : request.server.pihDependencies.cursorCodec.decode(query.cursor, {
              route: "/v1/tasks",
              filterHash: "none",
            });
      const page = await request.server.pihDependencies.queries.tasks.list({
        limit: query.limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      return pageResponse(request, page);
    },
  );

  app.post(
    "/v1/tasks",
    {
      config: { pihSecurity: { scopes: ["second-brain:write"], mutation: true } },
      schema: mutationRouteSchema({
        bodyRef: "CreateTaskBody",
        responseRef: "Task",
        status: 201,
        location: true,
      }),
    },
    async (request, reply) => {
      const body = parse(CreateTaskBodySchema, request.body);
      const result = await request.server.pihDependencies.unitOfWork.execute(
        ({ mutations }) => mutations.createTask(mutationContext(request), body),
      );
      return sendMutation(reply, result);
    },
  );

  app.patch(
    "/v1/tasks/:taskId",
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
          bodyRef: "PatchTaskBody",
          responseRef: "Task",
        }),
        params: taskParamsSchema,
      },
    },
    async (request, reply) => {
      const { taskId } = parse(taskParams, request.params);
      const body = parse(PatchTaskBodySchema, request.body);
      const result = await request.server.pihDependencies.unitOfWork.execute(
        ({ mutations }) => mutations.patchTask(mutationContext(request), taskId, body),
      );
      return sendMutation(reply, result);
    },
  );
};
