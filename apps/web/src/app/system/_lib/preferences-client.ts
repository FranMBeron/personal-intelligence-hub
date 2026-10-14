import {
  UserPreferencesSchema,
  type UpdateUserPreferencesBody,
  type UserPreferences,
} from "@personal-intelligence-hub/contracts";

import { bffJson, type Fetcher } from "../../_lib/bff-request";

/** Versioned user-preference reads and writes through the existing BFF preferences route. */
export class PreferencesClient {
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  get(signal?: AbortSignal): Promise<UserPreferences> {
    return bffJson(this.fetcher, "/api/ui/v1/preferences", UserPreferencesSchema, { signal });
  }

  update(body: UpdateUserPreferencesBody, signal?: AbortSignal): Promise<UserPreferences> {
    return bffJson(this.fetcher, "/api/ui/v1/preferences", UserPreferencesSchema, {
      method: "PATCH",
      body: { timeZone: body.timeZone, expectedVersion: body.expectedVersion },
      signal,
    });
  }
}
