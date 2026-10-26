import { ZodError } from "zod";

import { loadConnectorsConfig } from "../config/private.js";
import type { ProviderConfigNamespace } from "../config/provider-namespace.js";
import { providerConfigNamespaces } from "../providers.js";
import { isEntryPoint, type OperatorCommandIo } from "./command-line.js";

/** Fixed host paths from the private-connectors deployment contract. */
export const PRODUCTION_FIXED_VALUES: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: "production",
  CONNECTORS_SOCKET_PATH: "/run/pih-connectors/web/connectors.sock",
  CONNECTORS_DATABASE_PATH: "/var/lib/pih-connectors/connectors.sqlite",
});
/** Inside the dedicated agent directory (0750, agent group); the service root is not agent-readable. */
export const PRODUCTION_DELEGATION_SOCKET = "/run/pih-connectors/agents/hermes-delegation.sock";

type Environment = Readonly<Record<string, string | undefined>>;

type Invalid = Readonly<{ section: string; field?: string; reason?: string }>;

class ValidationFailure extends Error {
  readonly detail: Invalid;

  constructor(detail: Invalid) {
    super("Configuration is invalid");
    this.detail = detail;
  }
}

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{2,}$/u;
const KNOWN_PREFIX = /^(?:CONNECTORS|GOOGLE_CALENDAR|HERMES|DEVICE_CONNECTIONS?|DEFAULT|LOG|NODE)_[A-Z0-9_]+$|^(?:HOST|PORT|NODE_ENV|LOG_LEVEL)$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/**
 * Extract a variable name from a parser message. Parsers name variables but
 * never echo values; a token is printed only when it is an environment key
 * or matches a known configuration prefix.
 */
const fieldFromError = (error: unknown, environment: Environment, arrayField?: string): string | undefined => {
  if (error instanceof ZodError) {
    const segment = error.issues[0]?.path[0];
    if (typeof segment === "number") return arrayField;
    return typeof segment === "string" && SAFE_PATH_SEGMENT.test(segment) ? segment : undefined;
  }
  if (!(error instanceof Error)) return undefined;
  for (const token of error.message.split(/[^A-Za-z0-9_]+/u)) {
    if (VARIABLE_NAME.test(token) && (Object.hasOwn(environment, token) || KNOWN_PREFIX.test(token))) return token;
  }
  return undefined;
};

const withSection = <T>(section: string, environment: Environment, parse: () => T, arrayField?: string): T => {
  try {
    return parse();
  } catch (error) {
    // Foundation's only array-shaped value is the service credential list.
    const field = fieldFromError(error, environment, arrayField);
    throw new ValidationFailure(field === undefined ? { section } : { section, field });
  }
};

const assertProductionValues = (environment: Environment): void => {
  for (const [field, expected] of Object.entries(PRODUCTION_FIXED_VALUES)) {
    if (environment[field] !== expected) throw new ValidationFailure({ section: "production", field });
  }
  const delegationSocket = environment.HERMES_DELEGATION_SOCKET_PATH;
  if (delegationSocket !== undefined && delegationSocket !== PRODUCTION_DELEGATION_SOCKET) {
    throw new ValidationFailure({ section: "production", field: "HERMES_DELEGATION_SOCKET_PATH" });
  }
};

/**
 * Validate a complete connectors environment with the same production
 * parsers the service uses: the Foundation loader plus every registered
 * provider namespace. Returns nothing on success; throws a safe failure.
 */
export const validateConnectorsEnvironment = (
  environment: Environment,
  options: Readonly<{ production?: boolean; requireProviders?: readonly string[] }> = {},
  namespaces: readonly ProviderConfigNamespace<string, unknown>[] = providerConfigNamespaces,
): void => {
  const frozen = Object.freeze({ ...environment });
  if (options.production === true) assertProductionValues(frozen);
  // Foundation first so its failures are attributed to the shared settings.
  withSection("foundation", frozen, () => loadConnectorsConfig(frozen, []), "CONNECTORS_SERVICE_CREDENTIALS_JSON");
  for (const namespace of namespaces) {
    withSection(namespace.name, frozen, () => namespace.parse(frozen));
  }
  const config = withSection("foundation", frozen, () => loadConnectorsConfig(frozen, namespaces)) as unknown as
    Readonly<Record<string, unknown>>;
  for (const name of options.requireProviders ?? []) {
    if (config[name] === undefined) throw new ValidationFailure({ section: name, reason: "provider_not_configured" });
  }
};

const parseArguments = (argv: readonly string[]): Readonly<{ production: boolean; requireProviders: string[] }> => {
  const known = new Set(providerConfigNamespaces.map(({ name }) => name));
  const requireProviders: string[] = [];
  let production = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--production" && !production) {
      production = true;
    } else if (argument === "--require") {
      const name = argv[index + 1];
      if (name === undefined || !known.has(name) || requireProviders.includes(name)) {
        throw new ValidationFailure({ section: "", reason: "arguments_invalid" });
      }
      requireProviders.push(name);
      index += 1;
    } else {
      throw new ValidationFailure({ section: "", reason: "arguments_invalid" });
    }
  }
  return { production, requireProviders };
};

const describeFailure = (detail: Invalid): string => [
  "configuration_invalid",
  ...(detail.section === "" ? [] : [`section=${detail.section}`]),
  ...(detail.field === undefined ? [] : [`field=${detail.field}`]),
  ...(detail.reason === undefined ? [] : [`reason=${detail.reason}`]),
].join(" ");

export const validateConfigCommandMain = async (input: OperatorCommandIo & Readonly<{
  argv: readonly string[];
  environment: Environment;
}>): Promise<number> => {
  try {
    const options = parseArguments(input.argv);
    validateConnectorsEnvironment(input.environment, options);
    input.stdout.write("configuration_valid\n");
    return 0;
  } catch (error) {
    const detail = error instanceof ValidationFailure ? error.detail : { section: "", reason: "validation_failed_unexpected" };
    input.stderr.write(describeFailure(detail) + "\n");
    return 1;
  }
};

if (isEntryPoint(import.meta.url)) {
  void validateConfigCommandMain({
    argv: process.argv.slice(2),
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  }).then((code) => {
    process.exitCode = code;
  });
}
