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

import { EVENT_CURSOR_PATTERN, normalizeHermesEventStream } from "./hermes-event-stream";
import {
  failureResponse,
  jsonResponse,
  parseJsonBody,
  parseResourceId,
  problem,
  problemResponse,
  requireContext,
  requireEmptyQuery,
  requireGateway,
  requireSameOrigin,
  runAgentOperation,
  type ContextualRouteHandler,
  type RequestPolicy,
  type RouteHandler,
} from "./request-guards";

export type { RequestPolicy } from "./request-guards";

const ImageMimeTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);
const UPLOAD_FIELDS: ReadonlySet<string> = new Set(["conversationId", "kind", "media"]);

const invalidUpload = (message: string): ZodError =>
  new ZodError([{ code: "custom", path: ["media"], message }]);

/** Reads at most `limit` bytes; returns null (after cancelling the body) when exceeded. */
const readBoundedBody = async (request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Strict upload envelope: one existing conversation, optional `kind=attachment`, one media file. */
const parseUploadForm = async (request: Request, bytes: Uint8Array<ArrayBuffer>): Promise<{ conversationId: string; media: File }> => {
  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw invalidUpload("Expected a multipart upload.");
  }
  for (const key of form.keys()) {
    if (!UPLOAD_FIELDS.has(key)) throw invalidUpload("Unexpected upload field.");
  }
  const kinds = form.getAll("kind");
  if (kinds.length > 1 || (kinds.length === 1 && kinds[0] !== "attachment")) {
    throw invalidUpload("Only image attachments can be uploaded.");
  }
  const conversationIds = form.getAll("conversationId");
  const mediaEntries = form.getAll("media");
  const conversationId = conversationIds[0];
  const media = mediaEntries[0];
  if (
    conversationIds.length !== 1 || typeof conversationId !== "string" || conversationId.trim() === "" ||
    mediaEntries.length !== 1 || !(media instanceof File)
  ) {
    throw invalidUpload("Exactly one image file and an existing conversation are required.");
  }
  return { conversationId: parseResourceId(conversationId), media };
};

export const createCapabilitiesHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const queryFailure = requireEmptyQuery(request, authenticated.context);
    if (queryFailure !== null) return queryFailure;
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
    const queryFailure = requireEmptyQuery(request, authenticated.context);
    if (queryFailure !== null) return queryFailure;
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
    const queryFailure = requireEmptyQuery(request, authenticated.context);
    if (queryFailure !== null) return queryFailure;
    const availableGateway = requireGateway(request, authenticated.context, gateway, "Hermes");
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const body = await parseJsonBody(request, CreateConversationBodySchema);
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
    const queryFailure = requireEmptyQuery(request, authenticated.context);
    if (queryFailure !== null) return queryFailure;
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
      const body = await parseJsonBody(request, SendMessageBodySchema);
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
    const queryFailure = requireEmptyQuery(request, authenticated.context);
    if (queryFailure !== null) return queryFailure;
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
      // Take the per-identity rate-limit and concurrency slot before buffering the body, so
      // over-limit callers are rejected without any of their upload being read into memory.
      return await runAgentOperation(authenticated.context, policy, async () => {
        const bytes = await readBoundedBody(request, policy.maxUploadBodyBytes);
        if (bytes === null) {
          return problemResponse(problem(
            request, authenticated.context, 413, "payload_too_large", "Payload too large",
            "The upload request exceeds the configured byte limit.",
          ));
        }
        const { conversationId, media } = await parseUploadForm(request, bytes);
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
        const value = await availableGateway.upload(authenticated.context, media, "attachment", conversationId, request.signal);
        return jsonResponse(UploadedMediaSchema.parse(value), authenticated.context.requestId, 201);
      });
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

/**
 * Known risk (accepted for now): event streams are long-lived and are not counted against the
 * per-identity rate limit or concurrency slots, so one authenticated identity can hold many open
 * SSE connections (each holding an upstream socket and up to MAX_SSE_BLOCK_CHARS of buffer).
 * Bounding them needs a dedicated stream budget; no default is imposed here.
 */
export const createEventsHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler<"conversationId"> =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const queryFailure = requireEmptyQuery(request, authenticated.context);
    if (queryFailure !== null) return queryFailure;
    const availableGateway = requireGateway(request, authenticated.context, gateway, "Hermes");
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const { conversationId: rawConversationId } = await routeContext.params;
      const conversationId = parseResourceId(rawConversationId);
      const lastEventId = request.headers.get("last-event-id") ?? undefined;
      if (lastEventId !== undefined && !EVENT_CURSOR_PATTERN.test(lastEventId)) {
        throw new ZodError([{ code: "custom", path: ["last-event-id"], message: "Invalid event cursor." }]);
      }
      const upstream = await availableGateway.events(
        authenticated.context, conversationId, lastEventId, request.signal,
      );
      if (upstream.body === null) {
        return problemResponse(problem(
          request, authenticated.context, 503, "dependency_unavailable", "Dependency unavailable",
          "The conversation event stream is temporarily unavailable.",
        ));
      }
      return new Response(normalizeHermesEventStream(upstream.body), {
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
