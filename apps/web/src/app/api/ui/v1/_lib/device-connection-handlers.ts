import "server-only";

import {
  DeviceConnectionIdSchema,
  DeviceConnectionReconnectResultSchema,
  DeviceConnectionStatusSchema,
} from "@personal-intelligence-hub/contracts";
import { ZodError } from "zod";

import type { RequestContext } from "../../../../../server/context";
import type { DeviceConnectionsGateway } from "../../../../../server/ports/device-connections-gateway";
import {
  failureResponse,
  jsonResponse,
  problem,
  problemResponse,
  requireContext,
  requireEmptyQuery,
  requireGateway,
  requireSameOrigin,
  runAgentOperation,
  type ContextualRouteHandler,
  type RequestPolicy,
} from "./request-guards";

type Operation = (
  gateway: DeviceConnectionsGateway, context: RequestContext, connectionId: string, signal: AbortSignal,
) => Promise<Response>;

/** A reconnect carries no body: the only inputs are the path id and the fixed operation. */
const requireEmptyBody = async (request: Request): Promise<void> => {
  if (request.body === null) return;
  if ((await request.text()).length > 0) {
    throw new ZodError([{ code: "custom", path: [], message: "This operation does not accept a request body." }]);
  }
};

/**
 * Verified human first, then Origin for the mutation, then strict inputs. The browser only ever
 * names a connection id; the bridge socket, actor labels and commands stay server-side.
 */
const run = (
  gateway: DeviceConnectionsGateway | null,
  policy: RequestPolicy,
  mutation: boolean,
  operation: Operation,
): ContextualRouteHandler<"connectionId"> => async (request, routeContext) => {
  const authenticated = await requireContext(request, policy);
  if (!authenticated.ok) return authenticated.response;
  const { context } = authenticated;
  if (context.principal?.actorType !== "human") {
    return problemResponse(problem(
      request, context, 401, "authentication_required", "Authentication required",
      "A verified human identity is required for device connections.",
    ));
  }
  if (mutation) {
    const originFailure = requireSameOrigin(request, context, policy);
    if (originFailure !== null) return originFailure;
  }
  const queryFailure = requireEmptyQuery(request, context);
  if (queryFailure !== null) return queryFailure;
  try {
    const connectionId = DeviceConnectionIdSchema.parse((await routeContext.params).connectionId);
    if (mutation) await requireEmptyBody(request);
    const available = requireGateway(request, context, gateway, "Device connections");
    if (available instanceof Response) return available;
    return await operation(available, context, connectionId, request.signal);
  } catch (error) {
    return failureResponse(request, context, error);
  }
};

export const createDeviceConnectionStatusHandler = (
  gateway: DeviceConnectionsGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler<"connectionId"> =>
  run(gateway, policy, false, async (available, context, connectionId, signal) =>
    jsonResponse(DeviceConnectionStatusSchema.parse(await available.status(context, connectionId, signal)), context.requestId));

export const createDeviceConnectionReconnectHandler = (
  gateway: DeviceConnectionsGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler<"connectionId"> =>
  run(gateway, policy, true, async (available, context, connectionId, signal) => {
    // Long-running: bounded by the per-identity agent operation limits, never by the browser.
    const result = await runAgentOperation(context, policy, () => available.reconnect(context, connectionId, signal));
    return jsonResponse(DeviceConnectionReconnectResultSchema.parse(result), context.requestId);
  });
