import { describe, expect, it } from "vitest";

import {
  UpdateUserPreferencesBodySchema,
  UserPreferencesSchema,
} from "./preferences.js";

describe("user preference contracts", () => {
  it("rejects a server-derived or invalid time zone", () => {
    expect(UserPreferencesSchema.safeParse({
      timeZone: "America/Argentina/Buenos_Aires",
      version: 1,
    }).success).toBe(true);
    expect(UpdateUserPreferencesBodySchema.safeParse({
      timeZone: "UTC+3",
      expectedVersion: 1,
    }).success).toBe(false);
  });

  it("keeps actor identity out of the preference response", () => {
    expect(UserPreferencesSchema.parse({
      timeZone: "America/Argentina/Buenos_Aires",
      version: 1,
    })).toEqual({ timeZone: "America/Argentina/Buenos_Aires", version: 1 });
    expect(UserPreferencesSchema.safeParse({
      actorId: "018f5f17-5d0a-7c76-aac3-4f0f6ce44f10",
      timeZone: "UTC",
      version: 1,
    }).success).toBe(false);
  });
});
