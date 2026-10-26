import { describe, expect, it } from "vitest";

import * as contracts from "./index.js";
import {
  DeviceConnectionIdSchema,
  DeviceConnectionReconnectResultSchema,
  DeviceConnectionStatusSchema,
} from "./device-connections.js";

const status = {
  connectionId: "example-band",
  label: "Example band",
  state: "unavailable",
  reasonCode: "device_unreachable",
  action: "wake_device",
  checkedAt: "2026-10-26T12:00:00.000Z",
} as const;

describe("device connection contracts", () => {
  it("is exported from the package index", () => {
    expect(contracts.DeviceConnectionStatusSchema).toBe(DeviceConnectionStatusSchema);
  });

  it.each(["devices:read", "devices:write"])("defines the %s connector scope", (scope) => {
    expect(contracts.ConnectorScopeSchema.parse(scope)).toBe(scope);
  });

  it.each(["example-band", "a", "sensor-1"])("accepts the connection id %s", (id) => {
    expect(DeviceConnectionIdSchema.parse(id)).toBe(id);
  });

  it.each(["", "Band", "1band", "band_1", "band/../x", "band\n", "a".repeat(64), "-band"])(
    "rejects the connection id %j",
    (id) => {
      expect(DeviceConnectionIdSchema.safeParse(id).success).toBe(false);
    },
  );

  it("accepts an honest unavailable status with a wake action", () => {
    expect(DeviceConnectionStatusSchema.parse(status)).toEqual(status);
  });

  it("accepts a connected status with its authentication time", () => {
    const connected = {
      ...status, state: "connected", reasonCode: null, authenticatedAt: "2026-10-26T11:59:00.000Z",
    };
    delete (connected as Record<string, unknown>).action;
    expect(DeviceConnectionStatusSchema.parse(connected)).toEqual(connected);
  });

  it("rejects unknown fields, free-form reasons and unknown states", () => {
    expect(DeviceConnectionStatusSchema.safeParse({ ...status, socketPath: "/x.sock" }).success).toBe(false);
    expect(DeviceConnectionStatusSchema.safeParse({ ...status, reasonCode: "Bridge said: oops" }).success).toBe(false);
    expect(DeviceConnectionStatusSchema.safeParse({ ...status, state: "active" }).success).toBe(false);
    expect(DeviceConnectionStatusSchema.safeParse({ ...status, action: "run_command" }).success).toBe(false);
  });

  it("only allows an authentication time on a connected status", () => {
    expect(DeviceConnectionStatusSchema.safeParse({
      ...status, authenticatedAt: "2026-10-26T11:59:00.000Z",
    }).success).toBe(false);
  });

  it("never pairs connected with a retry delay or a wake action", () => {
    const connected = { ...status, state: "connected", reasonCode: null };
    expect(DeviceConnectionStatusSchema.safeParse(connected).success).toBe(false);
    const { action: _action, ...withoutAction } = connected;
    expect(DeviceConnectionStatusSchema.safeParse(withoutAction).success).toBe(true);
    expect(DeviceConnectionStatusSchema.safeParse({ ...withoutAction, retryAfterSeconds: 5 }).success).toBe(false);
  });

  it("bounds the retry delay", () => {
    const cooldown = { ...status, state: "failed", reasonCode: "cooldown" } as const;
    expect(DeviceConnectionStatusSchema.safeParse({ ...cooldown, retryAfterSeconds: 30 }).success).toBe(true);
    expect(DeviceConnectionStatusSchema.safeParse({ ...cooldown, retryAfterSeconds: 0 }).success).toBe(false);
    expect(DeviceConnectionStatusSchema.safeParse({ ...cooldown, retryAfterSeconds: 3601 }).success).toBe(false);
    expect(DeviceConnectionStatusSchema.safeParse({ ...cooldown, retryAfterSeconds: 1.5 }).success).toBe(false);
  });

  it("uses the same shape for reconnect results", () => {
    expect(DeviceConnectionReconnectResultSchema.parse(status)).toEqual(status);
  });
});
