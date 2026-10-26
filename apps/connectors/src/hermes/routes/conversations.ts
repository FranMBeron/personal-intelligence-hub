import {
  ConversationListSchema,
  ConversationSchema,
  ConversationSelectionSchema,
  type ConversationListQuery,
  type CreateConversationBody,
  type PatchConversationBody,
  type PutConversationSelectionBody,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";

import type { HermesRouteServices } from "../runtime.js";
import { authorize, noBody, noQuery, pathRefs, queryOf } from "./http.js";

/**
 * Direct conversation, main-thread, and selection routes. Bodies and queries are
 * passed unparsed to the services, which validate them with the strict contract
 * schemas; every result is re-parsed with its contract schema before serializing.
 */
export const registerConversationRoutes = async (app: FastifyInstance, services: HermesRouteServices): Promise<void> => {
  const conversations = services.conversations;

  app.get("/v1/conversations", async (request) => {
    const principal = authorize(request, "hermes:conversations:read");
    return ConversationListSchema.parse(await conversations.list(principal, queryOf(request) as ConversationListQuery));
  });

  app.post("/v1/conversations", async (request, reply) => {
    const principal = authorize(request, "hermes:conversations:write");
    noQuery(request);
    const created = ConversationSchema.parse(await conversations.create(principal, request.body as CreateConversationBody));
    return reply.code(201).send(created);
  });

  app.put("/v1/agents/:agentId/main-conversation", async (request) => {
    const principal = authorize(request, "hermes:conversations:write");
    const { agentId } = pathRefs(request, "agentId");
    noQuery(request);
    noBody(request);
    return ConversationSchema.parse(await conversations.ensureMain(principal, agentId));
  });

  app.get("/v1/conversations/:id", async (request) => {
    const principal = authorize(request, "hermes:conversations:read");
    const { id } = pathRefs(request, "id");
    noQuery(request);
    return ConversationSchema.parse(await conversations.get(principal, id));
  });

  app.patch("/v1/conversations/:id", async (request) => {
    const principal = authorize(request, "hermes:conversations:write");
    const { id } = pathRefs(request, "id");
    noQuery(request);
    return ConversationSchema.parse(await conversations.patch(principal, id, request.body as PatchConversationBody));
  });

  app.get("/v1/agents/:agentId/conversation-selection", async (request) => {
    const principal = authorize(request, "hermes:conversations:read");
    const { agentId } = pathRefs(request, "agentId");
    noQuery(request);
    return ConversationSelectionSchema.parse(await conversations.selection(principal, agentId));
  });

  app.put("/v1/agents/:agentId/conversation-selection", async (request) => {
    const principal = authorize(request, "hermes:conversations:write");
    const { agentId } = pathRefs(request, "agentId");
    noQuery(request);
    return ConversationSelectionSchema.parse(
      await conversations.putSelection(principal, agentId, request.body as PutConversationSelectionBody),
    );
  });
};
