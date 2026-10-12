import {
  SourceStatusSchema,
  type SourceStatus,
} from "../connectors.js";
import {
  UserPreferencesSchema,
  type UserPreferences,
} from "../preferences.js";

export const sourceStatusFixture = (
  overrides: Partial<SourceStatus> = {},
): SourceStatus => SourceStatusSchema.parse({
  id: "fictional-source",
  state: "available",
  checkedAt: "2026-10-12T12:00:00.000Z",
  lastSuccessAt: "2026-10-12T12:00:00.000Z",
  stale: false,
  capabilities: [],
  ...overrides,
});

export const preferencesFixture = (
  overrides: Partial<UserPreferences> = {},
): UserPreferences => UserPreferencesSchema.parse({
  timeZone: "Etc/UTC",
  version: 1,
  ...overrides,
});
