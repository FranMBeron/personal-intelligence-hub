import "server-only";

import {
  UpdateUserPreferencesBodySchema,
  UserPreferencesSchema,
  type UpdateUserPreferencesBody,
  type UserPreferences,
} from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";
import type { PreferencesGateway } from "../ports/preferences-gateway";
import type { ConnectorsHttp } from "./connectors-http";

export class HttpPreferencesGateway implements PreferencesGateway {
  constructor(private readonly http: Pick<ConnectorsHttp, "json">) {}

  get(context: RequestContext, signal?: AbortSignal): Promise<UserPreferences> {
    return this.http.json(context, {
      path: "/v1/preferences",
      method: "GET",
      schema: UserPreferencesSchema,
      scope: "preferences:read",
      signal,
    });
  }

  patch(context: RequestContext, body: UpdateUserPreferencesBody, signal?: AbortSignal): Promise<UserPreferences> {
    return this.http.json(context, {
      path: "/v1/preferences",
      method: "PATCH",
      schema: UserPreferencesSchema,
      body: UpdateUserPreferencesBodySchema.parse(body),
      scope: "preferences:write",
      signal,
    });
  }
}
