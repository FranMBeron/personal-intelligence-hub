import { describe, expect, it } from "vitest";

import { deviceConnectionsConfigNamespace } from "./config.js";

const complete = {
  DEVICE_CONNECTIONS_ENABLED: "true",
  DEVICE_CONNECTION_ID: "example-band",
  DEVICE_CONNECTION_LABEL: "Example band",
  DEVICE_CONNECTION_BRIDGE_SOCKET_PATH: "/run/example-device-bridge/bridge.sock",
  DEVICE_CONNECTION_HUMAN_ACTOR: "owner",
  DEVICE_CONNECTION_OWNER_ACTOR_ID: "0b9d6c55-3f39-4d8e-9a8e-5f9f8c1d2e3a",
  DEVICE_CONNECTION_AGENT_ACTORS_JSON: JSON.stringify({ coordinator: "agent-coordinator", health: "agent-health" }),
} as const;

const parse = (environment: Readonly<Record<string, string | undefined>>) =>
  deviceConnectionsConfigNamespace.parse(environment);

describe("device connections configuration", () => {
  it("uses a safe provider namespace name", () => {
    expect(deviceConnectionsConfigNamespace.name).toMatch(/^[a-z][a-z0-9-]*$/u);
  });

  it("is not configured when no device variable is present", () => {
    expect(parse({})).toBeUndefined();
    expect(parse({ DEVICE_CONNECTIONS_ENABLED: "false" })).toBeUndefined();
  });

  it("parses a complete configuration", () => {
    const config = parse(complete);
    expect(config?.connection).toMatchObject({
      id: "example-band",
      label: "Example band",
      bridgeSocketPath: "/run/example-device-bridge/bridge.sock",
      humanActor: "owner",
      ownerActorId: "0b9d6c55-3f39-4d8e-9a8e-5f9f8c1d2e3a",
    });
    expect(config?.connection.agentActors.get("coordinator")).toBe("agent-coordinator");
    expect(config?.connection.agentActors.get("health")).toBe("agent-health");
    expect(config?.connection.agentActors.get("finance")).toBeUndefined();
    expect(config?.connection.agentActors.get("constructor")).toBeUndefined();
  });

  it("accepts an explicitly empty agent allowlist", () => {
    expect(parse({ ...complete, DEVICE_CONNECTION_AGENT_ACTORS_JSON: "{}" })?.connection.agentActors.size).toBe(0);
  });

  it.each(Object.keys(complete).filter((key) => key !== "DEVICE_CONNECTIONS_ENABLED"))(
    "fails startup when %s is missing from an enabled configuration",
    (name) => {
      expect(() => parse({ ...complete, [name]: undefined })).toThrow();
    },
  );

  it("fails startup when settings are present but the integration is not enabled", () => {
    const { DEVICE_CONNECTIONS_ENABLED: _enabled, ...partial } = complete;
    expect(() => parse(partial)).toThrow();
    expect(() => parse({ ...complete, DEVICE_CONNECTIONS_ENABLED: "false" })).toThrow();
    expect(() => parse({ ...complete, DEVICE_CONNECTIONS_ENABLED: "yes" })).toThrow();
  });

  it.each([
    "relative/bridge.sock",
    "/run/example/../bridge.sock",
    "/run/example//bridge.sock",
    "/run/example/bridge",
    "/run/pih-connectors/web/bridge.sock",
    "/run/pih-connectors/agents/bridge.sock",
    "/" + "a".repeat(100) + ".sock",
    "/run/example/bridge\n.sock",
  ])("rejects the unsafe bridge socket path %j", (path) => {
    expect(() => parse({ ...complete, DEVICE_CONNECTION_BRIDGE_SOCKET_PATH: path })).toThrow();
  });

  it("rejects a bridge socket path that collides with a connectors socket", () => {
    const path = complete.DEVICE_CONNECTION_BRIDGE_SOCKET_PATH;
    expect(() => parse({ ...complete, CONNECTORS_SOCKET_PATH: path })).toThrow();
    expect(() => parse({ ...complete, HERMES_DELEGATION_SOCKET_PATH: path })).toThrow();
  });

  it.each(["Band", "band_1", "", "a".repeat(64)])("rejects the connection id %j", (id) => {
    expect(() => parse({ ...complete, DEVICE_CONNECTION_ID: id })).toThrow();
  });

  it.each(["", " ", "x".repeat(81), "line\nbreak"])("rejects the display label %j", (label) => {
    expect(() => parse({ ...complete, DEVICE_CONNECTION_LABEL: label })).toThrow();
  });

  it.each(["", "owner", "0b9d6c55-3f39-4d8e-9a8e", "0B9D6C55-3F39-4D8E-9A8E-5F9F8C1D2E3A "])("rejects the owner actor id %j", (owner) => {
    expect(() => parse({ ...complete, DEVICE_CONNECTION_OWNER_ACTOR_ID: owner })).toThrow(/DEVICE_CONNECTION_OWNER_ACTOR_ID/u);
  });

  it.each(["", "Owner", "owner name", "owner\"", "a".repeat(64)])("rejects the human actor %j", (actor) => {
    expect(() => parse({ ...complete, DEVICE_CONNECTION_HUMAN_ACTOR: actor })).toThrow();
  });

  it.each([
    "not json",
    "[]",
    "null",
    JSON.stringify({ Coordinator: "agent" }),
    JSON.stringify({ __proto__x: "agent" }),
    JSON.stringify({ coordinator: "Agent Name" }),
    JSON.stringify({ coordinator: 1 }),
    JSON.stringify(Object.fromEntries(Array.from({ length: 17 }, (_value, index) => ["profile-" + index, "agent"]))),
  ])("rejects the agent allowlist %j", (value) => {
    expect(() => parse({ ...complete, DEVICE_CONNECTION_AGENT_ACTORS_JSON: value })).toThrow();
  });

  it("does not echo configured values in validation errors", () => {
    let message = "";
    try {
      parse({ ...complete, DEVICE_CONNECTION_BRIDGE_SOCKET_PATH: "relative/secret-location.sock" });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain("secret-location");
  });
});
