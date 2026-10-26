import { z } from "zod";

import { TimestampSchema } from "./common.js";

/** Operator-configured connection identifier; a closed set chosen in private configuration. */
export const DeviceConnectionIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);

/** Honest states reported by the device bridge. "connected" is only ever relayed, never inferred. */
export const DeviceConnectionStateSchema = z.enum(["connecting", "connected", "unavailable", "failed"]);

/** Closed reason codes. Bridge text never crosses this boundary; unknown reasons become "unspecified". */
export const DeviceConnectionReasonCodeSchema = z.enum([
  "cooldown",
  "in_progress",
  "timeout",
  "device_unreachable",
  "authentication_failed",
  "actor_not_allowed",
  "unspecified",
]);

/** Closed set of actions a person can take; currently only waking the device. */
export const DeviceConnectionActionSchema = z.enum(["wake_device"]);

export const DeviceConnectionStatusSchema = z.object({
  connectionId: DeviceConnectionIdSchema,
  label: z.string().min(1).max(80).regex(/^[^\p{Cc}]+$/u),
  state: DeviceConnectionStateSchema,
  reasonCode: DeviceConnectionReasonCodeSchema.nullable(),
  action: DeviceConnectionActionSchema.optional(),
  authenticatedAt: TimestampSchema.optional(),
  retryAfterSeconds: z.number().int().min(1).max(3600).optional(),
  checkedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.state === "connected") {
    if (value.action !== undefined || value.retryAfterSeconds !== undefined) {
      context.addIssue({ code: "custom", path: ["state"], message: "A connected device has no pending action or retry delay." });
    }
  } else if (value.authenticatedAt !== undefined) {
    context.addIssue({ code: "custom", path: ["authenticatedAt"], message: "authenticatedAt is only valid when connected." });
  }
});

/** A reconnect returns the bridge's final, validated status for the connection. */
export const DeviceConnectionReconnectResultSchema = DeviceConnectionStatusSchema;

export type DeviceConnectionId = z.infer<typeof DeviceConnectionIdSchema>;
export type DeviceConnectionState = z.infer<typeof DeviceConnectionStateSchema>;
export type DeviceConnectionReasonCode = z.infer<typeof DeviceConnectionReasonCodeSchema>;
export type DeviceConnectionAction = z.infer<typeof DeviceConnectionActionSchema>;
export type DeviceConnectionStatus = z.infer<typeof DeviceConnectionStatusSchema>;
export type DeviceConnectionReconnectResult = z.infer<typeof DeviceConnectionReconnectResultSchema>;
