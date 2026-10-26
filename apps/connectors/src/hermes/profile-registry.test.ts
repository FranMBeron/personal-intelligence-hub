import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { loadHermesConfig } from "./config.js";
import { HermesProfileRegistry } from "./profile-registry.js";

const primaryKey = "fictional-primary-key-32-bytes";
const secondaryKey = "fictional-secondary-key-32-bytes";
const environment = () => ({
  HERMES_API_ORIGIN: "http://127.0.0.1:8642",
  HERMES_DEFAULT_PROFILE_ID: "primary",
  HERMES_PROFILES_JSON: JSON.stringify([
    { id: "primary", displayName: "Primary", keyEnvironment: "HERMES_PRIMARY_API_KEY", enabled: true, capabilities: { directConversations: true, images: true, delegationTarget: false } },
    { id: "secondary", displayName: "Secondary", keyEnvironment: "HERMES_SECONDARY_API_KEY", enabled: true, capabilities: { directConversations: true, images: false, delegationTarget: true } },
    { id: "disabled", displayName: "Disabled", keyEnvironment: "HERMES_DISABLED_API_KEY", enabled: false, capabilities: { directConversations: false, images: false, delegationTarget: false } },
  ]),
  HERMES_PRIMARY_API_KEY: primaryKey,
  HERMES_SECONDARY_API_KEY: secondaryKey,
  HERMES_UPLOAD_DIRECTORY: "/var/lib/pih-connectors/hermes-uploads",
  HERMES_IMAGE_MAX_BYTES: "5242880",
  HERMES_UPLOAD_TTL_SECONDS: "600",
  HERMES_EVENT_RETENTION_HOURS: "168",
  HERMES_IDEMPOTENCY_RETENTION_HOURS: "168",
});

const createRegistry = () => new HermesProfileRegistry(loadHermesConfig(environment()));

describe("Hermes profile registry", () => {
  it("lists only enabled configured profiles and selects the configured default", () => {
    const registry = createRegistry();
    expect(registry.list().map(({ id }) => id)).toEqual(["primary", "secondary"]);
    expect(registry.default().id).toBe("primary");
    expect(registry.require("secondary").capabilities.delegationTarget).toBe(true);
  });

  it("keeps profile lookup closed to the validated set", () => {
    const registry = createRegistry();
    expect(() => registry.require("unconfigured")).toThrow("Hermes profile is not configured");
    expect(() => registry.credential("disabled")).toThrow("Hermes profile is not configured");
    expect(() => registry.profileBaseUrl("unconfigured")).toThrow("Hermes profile is not configured");
  });

  it("returns only the credential's bearer authorization value", () => {
    expect(createRegistry().credential("secondary").authorizationValue()).toBe(`Bearer ${secondaryKey}`);
  });

  it("redacts credential JSON and inspection output", () => {
    const credential = createRegistry().credential("primary");
    expect(JSON.stringify(credential)).toBe('"[REDACTED]"');
    expect(inspect(credential)).toBe("[REDACTED]");
    expect(inspect(credential)).not.toContain(primaryKey);
  });

  it("does not let callers mutate the validated API origin", () => {
    const registry = createRegistry();
    const exposedOrigin = registry.config.apiOrigin;
    exposedOrigin.hostname = "192.0.2.10";
    expect(registry.config.apiOrigin.origin).toBe("http://127.0.0.1:8642");
    expect(registry.profileBaseUrl("secondary").origin).toBe("http://127.0.0.1:8642");
  });

  it("builds profile-scoped URLs only from the validated API origin", () => {
    expect(createRegistry().profileBaseUrl("secondary").href).toBe("http://127.0.0.1:8642/p/secondary/");
  });

  it("redacts registry inspection and serialized public profiles", () => {
    const registry = createRegistry();
    const serialized = JSON.stringify(registry.list());
    const diagnostic = inspect(registry);
    expect(serialized).not.toContain(primaryKey);
    expect(serialized).not.toContain(secondaryKey);
    expect(serialized).not.toContain("HERMES_PRIMARY_API_KEY");
    expect(diagnostic).not.toContain(primaryKey);
    expect(diagnostic).not.toContain(secondaryKey);
    expect(diagnostic).not.toContain("HERMES_PRIMARY_API_KEY");
    expect(diagnostic).not.toContain("127.0.0.1");
  });
});
