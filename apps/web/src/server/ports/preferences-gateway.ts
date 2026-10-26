import "server-only";

import type { UpdateUserPreferencesBody, UserPreferences } from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";

export interface PreferencesGateway {
  get(context: RequestContext, signal?: AbortSignal): Promise<UserPreferences>;
  patch(context: RequestContext, body: UpdateUserPreferencesBody, signal?: AbortSignal): Promise<UserPreferences>;
}
