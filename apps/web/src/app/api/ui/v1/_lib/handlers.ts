import "server-only";

import {
  AgentSummarySchema,
  ApiProblemSchema,
  ConversationSchema,
  CreateConversationBodySchema,
  HermesCapabilitiesSchema,
  IdempotencyKeySchema,
  MessageSchema,
  SendMessageBodySchema,
  UploadedMediaSchema,
  type ApiProblem,
} from "@personal-intelligence-hub/contracts";
import { z, ZodError } from "zod";

import {
  deriveRequestContext,
  type RequestContext,
  type RequestIdentityAdapter,
} from "../../../../../server/context";
import type { HermesGateway } from "../../../../../server/ports/hermes-gateway";
import { GatewayError } from "../../../../../server/problems";

type RouteContext = Readonly<{
  params: Promise<{ conversationId: string }>;
}>;

type RouteHandler = (request: Request) => Promise<Response>;
type ContextualRouteHandler = (
  request: Request,
  context: RouteContext,
) => Promise<Response>;

export type RequestPolicy = Readonly<{
  publicOrigin: string;
  identity: RequestIdentityAdapter;
}>;

const problemResponse = (problem: ApiProblem): Response =>
  new Response(JSON.stringify(ApiProblemSchema.parse(problem)), {
    status: problem.status,
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": problem.requestId,
    },
  });

const problem = (
  request: Request,
  context: RequestContext,
  status: number,
  code: ApiProblem["code"],
  title: string,
  detail: string,
  errors?: ApiProblem["errors"],
): ApiProblem => ({
  type: "about:blank",
  title,
  status,
  detail,
  instance: new URL(request.url).pathname,
  code,
  requestId: context.requestId,
  ...(errors === undefined ? {} : { errors }),
});

const validationProblem = (
  request: Request,
  context: RequestContext,
  error: ZodError,
): ApiProblem =>
  problem(
    request,
    context,
    422,
    "validation_failed",
    "Validation failed",
    "The request body does not match the public contract.",
    error.issues.map((issue) => ({
      path: issue.path.length === 0 ? "$" : issue.path.join("."),
      message: issue.message,
      code: issue.code,
    })),
  );

const requireContext = (
  request: Request,
  policy: RequestPolicy,
): Promise<
  { ok: true; context: RequestContext } | { ok: false; response: Response }
> =>
  deriveRequestContext(request.headers, undefined, policy.identity).then((result) =>
    result.ok
      ? result
      : { ok: false, response: problemResponse(result.problem) },
  );

const requireSameOrigin = (
  request: Request,
  context: RequestContext,
  policy: RequestPolicy,
): Response | null => {
  const origin = request.headers.get("origin");
  if (origin !== null && origin === policy.publicOrigin) return null;
  return problemResponse(
    problem(
      request,
      context,
      403,
      "forbidden",
      "Forbidden",
      "State-changing requests must come from the application origin.",
    ),
  );
};

const requireGateway = (
  request: Request,
  context: RequestContext,
  gateway: HermesGateway | null,
): HermesGateway | Response =>
  gateway ??
  problemResponse(
    problem(
      request,
      context,
      503,
      "dependency_unavailable",
      "Hermes not configured",
      "Hermes is not configured for this deployment.",
    ),
  );

const failureResponse = (
  request: Request,
  context: RequestContext,
  error: unknown,
): Response => {
  if (error instanceof GatewayError) return problemResponse(error.problem);
  if (error instanceof ZodError) return problemResponse(validationProblem(request, context, error));
  return problemResponse(
    problem(
      request,
      context,
      500,
      "internal_error",
      "Internal error",
      "The request could not be completed.",
    ),
  );
};

const jsonResponse = (value: unknown, requestId: string, status = 200): Response =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-request-id": requestId },
  });

const parseJson = async <T>(request: Request, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await request.json());

export const createCapabilitiesHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const availableGateway = requireGateway(request, authenticated.context, gateway);
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const value = HermesCapabilitiesSchema.parse(
        await availableGateway.capabilities(authenticated.context),
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
    const availableGateway = requireGateway(request, authenticated.context, gateway);
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const value = z
        .array(AgentSummarySchema)
        .parse(await availableGateway.agents(authenticated.context));
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
    const availableGateway = requireGateway(request, authenticated.context, gateway);
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const body = await parseJson(request, CreateConversationBodySchema);
      const value = ConversationSchema.parse(
        await availableGateway.createConversation(authenticated.context, body),
      );
      return jsonResponse(value, authenticated.context.requestId, 201);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createSendMessageHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const originFailure = requireSameOrigin(request, authenticated.context, policy);
    if (originFailure !== null) return originFailure;
    const idempotency = IdempotencyKeySchema.safeParse(
      request.headers.get("idempotency-key"),
    );
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
    const availableGateway = requireGateway(request, authenticated.context, gateway);
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const body = await parseJson(request, SendMessageBodySchema);
      const { conversationId } = await routeContext.params;
      const value = MessageSchema.parse(
        await availableGateway.sendMessage(
          authenticated.context,
          conversationId,
          idempotency.data,
          body,
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
    const availableGateway = requireGateway(request, authenticated.context, gateway);
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const form = await request.formData();
      const mediaEntries = form.getAll("media");
      const media = mediaEntries[0];
      const kind = form.get("kind");
      if (
        mediaEntries.length !== 1 ||
        !(media instanceof File) ||
        (kind !== "attachment" && kind !== "voice")
      ) {
        throw new ZodError([
          {
            code: "custom",
            path: ["media"],
            message: "Exactly one media file and a valid kind are required.",
          },
        ]);
      }
      const capabilities = HermesCapabilitiesSchema.parse(
        await availableGateway.capabilities(authenticated.context),
      );
      const negotiated =
        kind === "voice" ? capabilities.voice : capabilities.attachments;
      if (!negotiated.enabled || !negotiated.acceptedMimeTypes.includes(media.type)) {
        return problemResponse(
          problem(
            request,
            authenticated.context,
            415,
            "validation_failed",
            "Unsupported media type",
            "The selected media type is not enabled by Hermes.",
          ),
        );
      }
      if (media.size > negotiated.maxBytes) {
        return problemResponse(
          problem(
            request,
            authenticated.context,
            413,
            "validation_failed",
            "Media too large",
            "The selected media exceeds the negotiated byte limit.",
          ),
        );
      }
      const value = UploadedMediaSchema.parse(
        await availableGateway.upload(authenticated.context, media, kind),
      );
      return jsonResponse(value, authenticated.context.requestId, 201);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createEventsHandler = (
  gateway: HermesGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler =>
  async (request, routeContext) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const availableGateway = requireGateway(request, authenticated.context, gateway);
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const { conversationId } = await routeContext.params;
      const lastEventId = request.headers.get("last-event-id") ?? undefined;
      const upstream = await availableGateway.events(
        authenticated.context,
        conversationId,
        lastEventId,
      );
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "cache-control": "no-cache, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
          "x-request-id": authenticated.context.requestId,
        },
      });
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };
