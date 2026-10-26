import { describe, expect, it, vi } from "vitest";

import * as foundationConfig from "../config/private.js";
import { providerConfigNamespaces } from "../providers.js";
import {
  fictionalCalendarEnvironment,
  fictionalHermesEnvironment,
  fictionalOperatorEnvironment,
} from "../../test/operations/fixtures.js";
import { validateConfigCommandMain } from "./validate-config-command.js";

const deviceEnvironment = (): Record<string, string> => ({
  DEVICE_CONNECTIONS_ENABLED: "true",
  DEVICE_CONNECTION_ID: "fictional-band",
  DEVICE_CONNECTION_LABEL: "Fictional band",
  DEVICE_CONNECTION_BRIDGE_SOCKET_PATH: "/run/fictional-device-bridge/bridge.sock",
  DEVICE_CONNECTION_HUMAN_ACTOR: "owner",
  DEVICE_CONNECTION_AGENT_ACTORS_JSON: JSON.stringify({ orchestrator: "agent-orchestrator" }),
});

const completeEnvironment = (overrides: Readonly<Record<string, string>> = {}): Record<string, string> =>
  fictionalOperatorEnvironment("/var/lib/pih-connectors/connectors.sqlite", {
    ...fictionalCalendarEnvironment(),
    ...fictionalHermesEnvironment("/var/lib/pih-connectors/hermes-uploads"),
    ...deviceEnvironment(),
    ...overrides,
  });

const productionEnvironment = (overrides: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const { HOST: _host, PORT: _port, ...base } = completeEnvironment();
  return {
    ...base,
    NODE_ENV: "production",
    CONNECTORS_SOCKET_PATH: "/run/pih-connectors/web/connectors.sock",
    CONNECTORS_SOCKET_GID: "990",
    ...overrides,
  };
};

const run = async (argv: readonly string[], environment: Readonly<Record<string, string>>) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await validateConfigCommandMain({
    argv,
    environment,
    stdout: { write: (value: string) => out.push(value) },
    stderr: { write: (value: string) => err.push(value) },
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
};

const expectNoValues = (output: string, environment: Readonly<Record<string, string>>): void => {
  for (const value of Object.values(environment)) {
    if (value.length >= 6 && !/^\d+$/u.test(value)) expect(output).not.toContain(value);
  }
};

describe("validate-config-command", () => {
  it("accepts a complete environment through every registered provider namespace", async () => {
    const environment = completeEnvironment();
    // --require succeeds only when each namespace produced validated provider configuration.
    const result = await run(["--require", "calendar", "--require", "hermes", "--require", "devices"], environment);
    expect(result).toEqual({ code: 0, stdout: "configuration_valid\n", stderr: "" });
    expect(providerConfigNamespaces.map(({ name }) => name)).toEqual(["calendar", "hermes", "devices"]);
  });

  it("uses the Foundation loader rather than a second schema", async () => {
    const loader = vi.spyOn(foundationConfig, "loadConnectorsConfig");
    await run([], completeEnvironment());
    expect(loader).toHaveBeenCalledWith(expect.any(Object), providerConfigNamespaces);
    vi.restoreAllMocks();
  });

  it("accepts the fixed production socket and database paths", async () => {
    const result = await run(["--production", "--require", "calendar"], productionEnvironment());
    expect(result).toEqual({ code: 0, stdout: "configuration_valid\n", stderr: "" });
  });

  it.each([
    ["a Calendar redirect", { GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: "http://fictional-private-host.example.test/callback" }, "section=calendar field=oauthRedirectUri"],
    ["a non-loopback Hermes origin", { HERMES_API_ORIGIN: "http://192.0.2.10:8642" }, "section=hermes"],
    ["a device bridge inside the BFF directory", { DEVICE_CONNECTION_BRIDGE_SOCKET_PATH: "/run/pih-connectors/web/bridge.sock" }, "section=devices field=DEVICE_CONNECTION_BRIDGE_SOCKET_PATH"],
    ["a missing time zone", { DEFAULT_TIME_ZONE: "" }, "section=foundation field=DEFAULT_TIME_ZONE"],
    ["malformed service credentials", { CONNECTORS_SERVICE_CREDENTIALS_JSON: "{\"fictional-secret-fragment\":" }, "section=foundation field=CONNECTORS_SERVICE_CREDENTIALS_JSON"],
    ["an incomplete service credential", { CONNECTORS_SERVICE_CREDENTIALS_JSON: JSON.stringify([{ serviceId: "pih-web", serviceToken: "fictional-short-secret" }]) }, "section=foundation field=CONNECTORS_SERVICE_CREDENTIALS_JSON"],
    ["an unknown log level", { LOG_LEVEL: "fictional-verbose" }, "section=foundation"],
  ])("rejects %s with a safe section and field only", async (_name, overrides, expected) => {
    const environment = completeEnvironment(overrides);
    const result = await run([], environment);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`configuration_invalid ${expected}\n`);
    expectNoValues(result.stderr, environment);
  });

  it.each([
    ["CONNECTORS_SOCKET_PATH", { CONNECTORS_SOCKET_PATH: "/run/pih-connectors/other.sock" }],
    ["CONNECTORS_DATABASE_PATH", { CONNECTORS_DATABASE_PATH: "/var/tmp/connectors.sqlite" }],
    ["NODE_ENV", { NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0" }],
    ["HERMES_DELEGATION_SOCKET_PATH", {
      HERMES_DELEGATION_ORCHESTRATOR_ID: "orchestrator",
      HERMES_DELEGATION_SOCKET_PATH: "/run/fictional/other-delegation.sock",
      HERMES_DELEGATION_SOCKET_GROUP_ID: "991",
      HERMES_DELEGATION_PEERS_JSON: "[]",
    }],
  ])("requires the fixed production value for %s", async (field, overrides) => {
    const result = await run(["--production"], productionEnvironment(overrides));
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`configuration_invalid section=production field=${field}\n`);
  });

  it("reports a required provider that is not configured", async () => {
    const environment = fictionalOperatorEnvironment("/var/lib/pih-connectors/connectors.sqlite");
    const result = await run(["--require", "hermes"], environment);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "configuration_invalid section=hermes reason=provider_not_configured\n" });
  });

  it.each([
    [["--require"]],
    [["--require", "unknown-provider"]],
    [["--unexpected"]],
    [["positional"]],
  ])("rejects malformed arguments %j", async (argv) => {
    const result = await run(argv, completeEnvironment());
    expect(result).toEqual({ code: 1, stdout: "", stderr: "configuration_invalid reason=arguments_invalid\n" });
  });
});
