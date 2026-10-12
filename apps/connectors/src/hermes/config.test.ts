import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadHermesConfig } from "./config.js";
import { HermesProfileRegistry } from "./profile-registry.js";

const orchestratorKey = "fictional-orchestrator-key-32-bytes";
const specialistKey = "fictional-specialist-key-32-bytes";
const environment = () => ({
  HERMES_API_ORIGIN: "http://127.0.0.1:8642",
  HERMES_DEFAULT_PROFILE_ID: "orchestrator",
  HERMES_PROFILES_JSON: JSON.stringify([
    {
      id: "orchestrator",
      displayName: "Orchestrator",
      keyEnvironment: "HERMES_ORCHESTRATOR_API_KEY",
      enabled: true,
      capabilities: { directConversations: true, images: true, delegationTarget: false },
    },
    {
      id: "specialist",
      displayName: "Specialist",
      keyEnvironment: "HERMES_SPECIALIST_API_KEY",
      enabled: true,
      capabilities: { directConversations: true, images: true, delegationTarget: true },
    },
  ]),
  HERMES_ORCHESTRATOR_API_KEY: orchestratorKey,
  HERMES_SPECIALIST_API_KEY: specialistKey,
  HERMES_UPLOAD_DIRECTORY: "/var/lib/pih-connectors/hermes-uploads",
  HERMES_IMAGE_MAX_BYTES: "5242880",
  HERMES_UPLOAD_TTL_SECONDS: "600",
  HERMES_EVENT_RETENTION_HOURS: "168",
  HERMES_IDEMPOTENCY_RETENTION_HOURS: "168",
});

const repositoryRoot = resolve(fileURLToPath(import.meta.url), "../../../../");
const expectSafeFailure = (input: Record<string, string | undefined>) => {
  let caught: unknown;
  try {
    loadHermesConfig(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).not.toContain(orchestratorKey);
  expect(message).not.toContain(specialistKey);
  expect(message).not.toContain("HERMES_ORCHESTRATOR_API_KEY");
  expect(message).not.toContain("HERMES_SPECIALIST_API_KEY");
  for (const environmentName of Object.keys(environment())) {
    expect(message).not.toContain(environmentName);
  }
  return message;
};

describe("Hermes private configuration", () => {
  it("loads a complete generic installation and redacts diagnostics", () => {
    const config = loadHermesConfig(environment());
    expect(config.defaultProfileId).toBe("orchestrator");
    expect(config.profiles).toHaveLength(2);
    expect(JSON.stringify(config)).not.toContain(orchestratorKey);
    expect(JSON.stringify(config)).not.toContain(specialistKey);
    expect(JSON.stringify(config)).not.toContain("HERMES_ORCHESTRATOR_API_KEY");
    expect(JSON.stringify(config)).not.toContain("/var/lib/pih-connectors/hermes-uploads");
    expect(JSON.stringify(config)).not.toContain("127.0.0.1");
    const diagnostic = inspect(config);
    expect(diagnostic).not.toContain(orchestratorKey);
    expect(diagnostic).not.toContain(specialistKey);
    expect(diagnostic).not.toContain("HERMES_ORCHESTRATOR_API_KEY");
    expect(diagnostic).not.toContain("/var/lib/pih-connectors/hermes-uploads");
    expect(diagnostic).not.toContain("127.0.0.1");
    expect(diagnostic).toContain("profileCount");
  });

  it("rejects every partial configuration", () => {
    const partial: Record<string, string | undefined> = { ...environment() };
    delete partial.HERMES_IDEMPOTENCY_RETENTION_HOURS;
    expectSafeFailure(partial);
  });

  it.each([
    ["image size below minimum", "HERMES_IMAGE_MAX_BYTES", "0"],
    ["image size above maximum", "HERMES_IMAGE_MAX_BYTES", "10485761"],
    ["upload TTL below minimum", "HERMES_UPLOAD_TTL_SECONDS", "59"],
    ["upload TTL above maximum", "HERMES_UPLOAD_TTL_SECONDS", "3601"],
    ["event retention below minimum", "HERMES_EVENT_RETENTION_HOURS", "23"],
    ["event retention above maximum", "HERMES_EVENT_RETENTION_HOURS", "721"],
    ["idempotency retention shorter than event retention", "HERMES_IDEMPOTENCY_RETENTION_HOURS", "167"],
    ["idempotency retention above maximum", "HERMES_IDEMPOTENCY_RETENTION_HOURS", "721"],
  ])("rejects %s", (_description, setting, value) => {
    expectSafeFailure({ ...environment(), [setting]: value });
  });

  it.each([
    ["non-loopback", "http://192.0.2.10:8642"],
    ["credentialed", "http://user:pass@127.0.0.1:8642"],
    ["path", "http://127.0.0.1:8642/api"],
    ["query", "http://127.0.0.1:8642?x=y"],
    ["fragment", "http://127.0.0.1:8642#x"],
    ["hostname", "http://localhost:8642"],
    ["missing port", "http://127.0.0.1"],
    ["numeric alternate host", "http://2130706433:8642"],
    ["octal alternate host", "http://0177.0.0.1:8642"],
    ["dot path", "http://127.0.0.1:8642/."],
    ["empty query", "http://127.0.0.1:8642?"],
    ["empty fragment", "http://127.0.0.1:8642#"],
  ])("rejects a %s Hermes origin", (_kind, origin) => {
    const message = expectSafeFailure({ ...environment(), HERMES_API_ORIGIN: origin });
    expect(message).toMatch(/loopback/u);
  });

  it("accepts the literal IPv6 loopback origin", () => {
    expect(loadHermesConfig({ ...environment(), HERMES_API_ORIGIN: "http://[::1]:8642" }).apiOrigin.hostname).toBe("[::1]");
  });

  it("rejects credential environment references shared by multiple profiles", () => {
    const env = environment();
    const profiles = JSON.parse(env.HERMES_PROFILES_JSON) as Array<Record<string, unknown>>;
    profiles[1]!.keyEnvironment = "HERMES_ORCHESTRATOR_API_KEY";
    env.HERMES_PROFILES_JSON = JSON.stringify(profiles);
    expect(expectSafeFailure(env)).toMatch(/credential/u);
  });

  it("rejects the same API key value assigned to multiple profiles", () => {
    expect(expectSafeFailure({ ...environment(), HERMES_SPECIALIST_API_KEY: orchestratorKey })).toMatch(/credential/u);
  });

  it("rejects duplicate profile identifiers", () => {
    const env = environment();
    const profiles = JSON.parse(env.HERMES_PROFILES_JSON) as Array<Record<string, unknown>>;
    env.HERMES_PROFILES_JSON = JSON.stringify([...profiles, profiles[0]]);
    expect(expectSafeFailure(env)).toMatch(/profile/u);
  });

  it("rejects missing referenced keys only after validating the profile list", () => {
    const env: Record<string, string | undefined> = { ...environment() };
    delete env.HERMES_SPECIALIST_API_KEY;
    expect(expectSafeFailure(env)).toMatch(/credential/u);
  });

  it("rejects a missing or disabled default profile", () => {
    expect(expectSafeFailure({ ...environment(), HERMES_DEFAULT_PROFILE_ID: "missing" })).toMatch(/default/u);
    const env = environment();
    const profiles = JSON.parse(env.HERMES_PROFILES_JSON) as Array<Record<string, unknown>>;
    profiles[0]!.enabled = false;
    env.HERMES_PROFILES_JSON = JSON.stringify(profiles);
    expect(expectSafeFailure(env)).toMatch(/default/u);
  });

  it("requires a safe absolute upload path outside the repository", () => {
    expect(expectSafeFailure({ ...environment(), HERMES_UPLOAD_DIRECTORY: "relative/uploads" })).toMatch(/upload/u);
    expect(expectSafeFailure({ ...environment(), HERMES_UPLOAD_DIRECTORY: resolve(repositoryRoot, "uploads") })).toMatch(/upload/u);
  });

  it("rejects unknown profile JSON fields", () => {
    const env = environment();
    const profiles = JSON.parse(env.HERMES_PROFILES_JSON) as Array<Record<string, unknown>>;
    profiles[0]!.apiKey = orchestratorKey;
    env.HERMES_PROFILES_JSON = JSON.stringify(profiles);
    expectSafeFailure(env);
  });

  it("rejects an enabled profile that can act as both gateway default and delegation target", () => {
    const env = environment();
    const profiles = JSON.parse(env.HERMES_PROFILES_JSON) as Array<Record<string, unknown>>;
    const capabilities = profiles[0]!.capabilities as Record<string, boolean>;
    capabilities.delegationTarget = true;
    env.HERMES_PROFILES_JSON = JSON.stringify(profiles);
    expect(expectSafeFailure(env)).toMatch(/default/u);
  });
});
