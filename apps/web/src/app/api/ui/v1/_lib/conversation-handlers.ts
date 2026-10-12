import "server-only";

import {
  ConversationListQuerySchema,
  ConversationListSchema,
  ConversationSchema,
  ConversationSelectionSchema,
  DelegationListQuerySchema,
  DelegationListSchema,
  DelegationSchema,
  MessageHistorySchema,
  MessagePageQuerySchema,
  PatchConversationBodySchema,
  PutConversationSelectionBodySchema,
} from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../../../../../server/context";
import type { HermesGateway } from "../../../../../server/ports/hermes-gateway";
import {
  failureResponse,
  jsonResponse,
  parseJsonBody,
  parseResourceId,
  parseStrictQuery,
  requireContext,
  requireGateway,
  requireSameOrigin,
  runAgentOperation,
  type ContextualRouteHandler,
  type RequestPolicy,
  type RouteHandler,
} from "./request-guards";

type ConversationParam = ContextualRouteHandler<"conversationId">;
type AgentParam = ContextualRouteHandler<"agentId">;
type DelegationParam = ContextualRouteHandler<"delegationId">;

const hermesGateway = (
  request: Request,
  context: RequestContext,
  gateway: HermesGateway | null,
): HermesGateway | Response => requireGateway(request, context, gateway, "Hermes");

export const createListConversationsHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    try {
      const query = parseStrictQuery(request, ConversationListQuerySchema);
      const availableGateway = hermesGateway(request, authenticated.context, gateway);
      if (availableGateway instanceof Response) return availableGateway;
      const result = ConversationListSchema.parse(
        await availableGateway.listConversations(authenticated.context, query, request.signal),
      );
      return jsonResponse(result, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createGetConversationHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): ConversationParam =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    try {
      const { conversationId: rawId } = await routeContext.params;
      const conversationId = parseResourceId(rawId);
      const availableGateway = hermesGateway(request, authenticated.context, gateway);
      if (availableGateway instanceof Response) return availableGateway;
      const result = ConversationSchema.parse(
        await availableGateway.getConversation(authenticated.context, conversationId, request.signal),
      );
      return jsonResponse(result, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createUpdateConversationHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): ConversationParam =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const originFailure = requireSameOrigin(request, authenticated.context, policy);
    if (originFailure !== null) return originFailure;
    try {
      const { conversationId: rawId } = await routeContext.params;
      const conversationId = parseResourceId(rawId);
      const body = await parseJsonBody(request, PatchConversationBodySchema);
      const availableGateway = hermesGateway(request, authenticated.context, gateway);
      if (availableGateway instanceof Response) return availableGateway;
      const result = ConversationSchema.parse(
        await runAgentOperation(authenticated.context, policy, () =>
          availableGateway.updateConversation(authenticated.context, conversationId, body, request.signal),
        ),
      );
      return jsonResponse(result, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createGetMessageHistoryHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): ConversationParam =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    try {
      const { conversationId: rawId } = await routeContext.params;
      const conversationId = parseResourceId(rawId);
      const query = parseStrictQuery(request, MessagePageQuerySchema);
      const availableGateway = hermesGateway(request, authenticated.context, gateway);
      if (availableGateway instanceof Response) return availableGateway;
      const result = MessageHistorySchema.parse(
        await availableGateway.history(authenticated.context, conversationId, query, request.signal),
      );
      return jsonResponse(result, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createResolveMainConversationHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): AgentParam =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const originFailure = requireSameOrigin(request, authenticated.context, policy);
    if (originFailure !== null) return originFailure;
    try {
      const { agentId: rawId } = await routeContext.params;
      const agentId = parseResourceId(rawId);
      const availableGateway = hermesGateway(request, authenticated.context, gateway);
      if (availableGateway instanceof Response) return availableGateway;
      const result = ConversationSchema.parse(
        await runAgentOperation(authenticated.context, policy, () =>
          availableGateway.resolveMainConversation(authenticated.context, agentId, request.signal),
        ),
      );
      return jsonResponse(result, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createGetConversationSelectionHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): AgentParam =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    try {
      const { agentId: rawId } = await routeContext.params;
      const agentId = parseResourceId(rawId);
      const availableGateway = hermesGateway(request, authenticated.context, gateway);
      if (availableGateway instanceof Response) return availableGateway;
      const result = ConversationSelectionSchema.parse(
        await availableGateway.getConversationSelection(authenticated.context, agentId, request.signal),
      );
      return jsonResponse(result, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createSelectConversationHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): AgentParam =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const originFailure = requireSameOrigin(request, authenticated.context, policy);
    if (originFailure !== null) return originFailure;
    try {
      const { agentId: rawId } = await routeContext.params;
      const agentId = parseResourceId(rawId);
      const body = await parseJsonBody(request, PutConversationSelectionBodySchema);
      const availableGateway = hermesGateway(request, authenticated.context, gateway);
      if (availableGateway instanceof Response) return availableGateway;
      const result = ConversationSelectionSchema.parse(
        await runAgentOperation(authenticated.context, policy, () =>
          availableGateway.selectConversation(authenticated.context, agentId, body, request.signal),
        ),
      );
      return jsonResponse(result, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createListDelegationsHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    try {
      const query = parseStrictQuery(request, DelegationListQuerySchema);
      const availableGateway = hermesGateway(request, authenticated.context, gateway);
      if (availableGateway instanceof Response) return availableGateway;
      const result = DelegationListSchema.parse(
        await availableGateway.listDelegations(authenticated.context, query, request.signal),
      );
      return jsonResponse(result, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createGetDelegationHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): DelegationParam =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    try {
      const { delegationId: rawId } = await routeContext.params;
      const delegationId = parseResourceId(rawId);
      const availableGateway = hermesGateway(request, authenticated.context, gateway);
      if (availableGateway instanceof Response) return availableGateway;
      const result = DelegationSchema.parse(
        await availableGateway.getDelegation(authenticated.context, delegationId, request.signal),
      );
      return jsonResponse(result, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };
