import { z } from "zod";

const TimeZoneSchema = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "timeZone must be an IANA time zone");

export const UserPreferencesSchema = z
  .object({
    timeZone: TimeZoneSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const UpdateUserPreferencesBodySchema = z
  .object({
    timeZone: UserPreferencesSchema.shape.timeZone,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export type UserPreferences = z.infer<typeof UserPreferencesSchema>;
export type UpdateUserPreferencesBody = z.infer<typeof UpdateUserPreferencesBodySchema>;
