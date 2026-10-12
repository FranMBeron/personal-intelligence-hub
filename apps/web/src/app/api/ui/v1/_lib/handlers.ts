import "server-only";

import {
  AgentSummarySchema,
  CreateConversationBodySchema,
  ConversationSchema,
  HermesCapabilitiesSchema,
  IdempotencyKeySchema,
  MessageSchema,
  SendMessageBodySchema,
  UploadedMediaSchema,
} from "@personal-intelligence-hub/contracts";
import { z, ZodError } from "zod";

import type { HermesGateway } from "../../../../../server/ports/hermes-gateway";

const ImageMimeTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);

import {
  failureResponse,
  jsonResponse,
  parseJson,
  parseResourceId,
  problem,
  problemResponse,
  requireContext,
  requireGateway,
  requireSameOrigin,
  runAgentOperation,
  type ContextualRouteHandler,
  type RequestPolicy,
  type RouteHandler,
} from "./request-guards";

export type { RequestPolicy } from "./request-guards";

export const createCapabilitiesHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const availableGateway = requireGateway(request, authenticated.context, gateway, "Hermes");
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const value = HermesCapabilitiesSchema.parse(
        await availableGateway.capabilities(authenticated.context, request.signal),
      );
      return jsonResponse(value, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createAgentsHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const availableGateway = requireGateway(request, authenticated.context, gateway, "Hermes");
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const value = z.array(AgentSummarySchema).parse(
        await availableGateway.agents(authenticated.context, request.signal),
      );
      return jsonResponse(value, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createConversationHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const originFailure = requireSameOrigin(request, authenticated.context, policy);
    if (originFailure !== null) return originFailure;
    const availableGateway = requireGateway(request, authenticated.context, gateway, "Hermes");
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const body = await parseJson(request, CreateConversationBodySchema);
      const value = ConversationSchema.parse(
        await runAgentOperation(authenticated.context, policy, () =>
          availableGateway.createConversation(authenticated.context, body, request.signal),
        ),
      );
      return jsonResponse(value, authenticated.context.requestId, 201);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createSendMessageHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler<"conversationId"> =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const originFailure = requireSameOrigin(request, authenticated.context, policy);
    if (originFailure !== null) return originFailure;
    const idempotency = IdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    if (!idempotency.success) {
      return problemResponse(
        problem(
          request,
          authenticated.context,
          400,
          "idempotency_key_required",
          "Valid idempotency key required",
          "Idempotency-Key must contain 8 to 255 visible ASCII characters.",
        ),
      );
    }
    const availableGateway = requireGateway(request, authenticated.context, gateway, "Hermes");
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const body = await parseJson(request, SendMessageBodySchema);
      const { conversationId: rawConversationId } = await routeContext.params;
      const conversationId = parseResourceId(rawConversationId);
      const value = MessageSchema.parse(
        await runAgentOperation(authenticated.context, policy, () =>
          availableGateway.sendMessage(authenticated.context, conversationId, idempotency.data, body, request.signal),
        ),
      );
      return jsonResponse(value, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createUploadHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const originFailure = requireSameOrigin(request, authenticated.context, policy);
    if (originFailure !== null) return originFailure;
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > policy.maxUploadBodyBytes) {
      return problemResponse(problem(
        request, authenticated.context, 413, "payload_too_large", "Payload too large",
        "The upload request exceeds the configured byte limit.",
      ));
    }
    const availableGateway = requireGateway(request, authenticated.context, gateway, "Hermes");
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const form = await request.formData();
      const mediaEntries = form.getAll("media");
      const media = mediaEntries[0];
      const conversationIdValue = form.get("conversationId");
      if (mediaEntries.length !== 1 || !(media instanceof File) || typeof conversationIdValue !== "string" || conversationIdValue.trim() === "") {
        throw new ZodError([{ code: "custom", path: ["media"], message: "Exactly one image file and an existing conversation are required." }]);
      }
      const capabilities = HermesCapabilitiesSchema.parse(
        await availableGateway.capabilities(authenticated.context, request.signal),
      );
      const mimeType = ImageMimeTypeSchema.safeParse(media.type);
      if (!capabilities.attachments.enabled || !mimeType.success || !capabilities.attachments.acceptedMimeTypes.includes(mimeType.data)) {
        return problemResponse(problem(
          request, authenticated.context, 415, "validation_failed", "Unsupported media type",
          "The selected image type is not enabled by Hermes.",
        ));
      }
      if (media.size > capabilities.attachments.maxBytes) {
        return problemResponse(problem(
          request, authenticated.context, 413, "payload_too_large", "Media too large",
          "The selected media exceeds the negotiated byte limit.",
        ));
      }
      const value = await runAgentOperation(authenticated.context, policy, () =>
        availableGateway.upload(authenticated.context, media, "attachment", parseResourceId(conversationIdValue), request.signal),
      );
      return jsonResponse(UploadedMediaSchema.parse(value), authenticated.context.requestId, 201);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createEventsHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler<"conversationId"> =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const availableGateway = requireGateway(request, authenticated.context, gateway, "Hermes");
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const { conversationId: rawConversationId } = await routeContext.params;
      const conversationId = parseResourceId(rawConversationId);
      const lastEventId = request.headers.get("last-event-id") ?? undefined;
      const upstream = await availableGateway.events(
        authenticated.context, conversationId, lastEventId, request.signal,
      );
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "cache-control": "no-store, no-cache, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
          "x-request-id": authenticated.context.requestId,
        },
      });
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };
