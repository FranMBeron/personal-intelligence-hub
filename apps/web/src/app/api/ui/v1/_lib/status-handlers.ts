import "server-only";

import {
  SystemStatusSchema,
  UpdateUserPreferencesBodySchema,
  UserPreferencesSchema,
} from "@personal-intelligence-hub/contracts";

import type { PreferencesGateway } from "../../../../../server/ports/preferences-gateway";
import type { SystemGateway } from "../../../../../server/ports/system-gateway";
import {
  failureResponse,
  jsonResponse,
  parseJsonBody,
  requireContext,
  requireEmptyQuery,
  requireGateway,
  requireSameOrigin,
  type RequestPolicy,
  type RouteHandler,
} from "./request-guards";

export const createSystemStatusHandler = (
  gateway: SystemGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const queryFailure = requireEmptyQuery(request, authenticated.context);
    if (queryFailure !== null) return queryFailure;
    const availableGateway = requireGateway(request, authenticated.context, gateway, "System status");
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const status = SystemStatusSchema.parse(
        await availableGateway.status(authenticated.context, request.signal),
      );
      return jsonResponse(status, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createGetPreferencesHandler = (
  gateway: PreferencesGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const queryFailure = requireEmptyQuery(request, authenticated.context);
    if (queryFailure !== null) return queryFailure;
    const availableGateway = requireGateway(request, authenticated.context, gateway, "Preferences");
    if (availableGateway instanceof Response) return availableGateway;
    try {
      const preferences = UserPreferencesSchema.parse(
        await availableGateway.get(authenticated.context, request.signal),
      );
      return jsonResponse(preferences, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };

export const createPatchPreferencesHandler = (
  gateway: PreferencesGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const authenticated = await requireContext(request, policy);
    if (!authenticated.ok) return authenticated.response;
    const originFailure = requireSameOrigin(request, authenticated.context, policy);
    if (originFailure !== null) return originFailure;
    const queryFailure = requireEmptyQuery(request, authenticated.context);
    if (queryFailure !== null) return queryFailure;
    try {
      const body = await parseJsonBody(request, UpdateUserPreferencesBodySchema);
      const availableGateway = requireGateway(request, authenticated.context, gateway, "Preferences");
      if (availableGateway instanceof Response) return availableGateway;
      const preferences = UserPreferencesSchema.parse(
        await availableGateway.patch(authenticated.context, body, request.signal),
      );
      return jsonResponse(preferences, authenticated.context.requestId);
    } catch (error) {
      return failureResponse(request, authenticated.context, error);
    }
  };
