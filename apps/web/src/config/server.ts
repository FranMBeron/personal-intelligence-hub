import "server-only";

import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { DelegatedJwtKeySchema, UuidSchema } from "@personal-intelligence-hub/contracts";

const defaultApiInternalUrl = "http://127.0.0.1:3001";
const defaultPublicOrigin = "http://127.0.0.1:3000";
const defaultConnectorsSocketPath = "/run/pih-connectors/connectors.sock";

const parseAllowedUsers = (
  value: string | undefined,
): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error("TAILSCALE_ALLOWED_USERS must contain login=actor-uuid entries.");
    }
    const login = entry.slice(0, separator).toLowerCase();
    if (Object.hasOwn(result, login)) {
      throw new Error("TAILSCALE_ALLOWED_USERS contains a duplicate login.");
    }
    result[login] = entry.slice(separator + 1);
  }
  return result;
};

const parseConnectorsAllowedUsers = (
  value: string | undefined,
): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error("CONNECTORS_TAILSCALE_ALLOWED_USERS must contain login=actor-uuid entries.");
    }
    const login = entry.slice(0, separator).toLowerCase();
    const actorId = entry.slice(separator + 1);
    if (Object.hasOwn(result, login) || !UuidSchema.safeParse(actorId).success) {
      throw new Error("CONNECTORS_TAILSCALE_ALLOWED_USERS contains an invalid mapping.");
    }
    result[login] = actorId;
  }
  return result;
};

const uncredentialedHttpUrl = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Expected a valid HTTP(S) URL." });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Expected an HTTP(S) URL." });
    }
    if (url.username !== "" || url.password !== "") {
      context.addIssue({ code: "custom", message: "Expected an uncredentialed URL." });
    }
  })
  .transform((value) => new URL(value).toString());

const httpsUrl = z.string().min(1).superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "Expected a valid HTTPS URL." });
    return;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    context.addIssue({ code: "custom", message: "Expected an uncredentialed HTTPS URL." });
  }
}).transform((value) => new URL(value).toString());

const privateSocketPath = z.string().min(1).superRefine((value, context) => {
  if (!isAbsolute(value) || !value.endsWith(".sock") || value.includes("\0")) {
    context.addIssue({ code: "custom", message: "Expected an absolute Unix socket path." });
  }
});

const trustedProxyCidr = z.string().superRefine((value, context) => {
  const [address, prefix, extra] = value.split("/");
  const family = address === undefined ? 0 : isIP(address);
  const bits = prefix === undefined ? Number.NaN : Number(prefix);
  if (
    extra !== undefined ||
    family === 0 ||
    prefix === undefined ||
    !/^\d+$/u.test(prefix) ||
    !Number.isInteger(bits) ||
    bits < 0 ||
    bits > (family === 4 ? 32 : 128)
  ) {
    context.addIssue({ code: "custom", message: "Expected an IP CIDR for the trusted proxy." });
  }
});

const connectorAllowedUsersSchema = z.record(z.string().min(1), z.uuid()).refine(
  (value) => Object.keys(value).length > 0,
  "At least one Tailscale user mapping is required.",
);

const ConnectorsConfigSchema = z.discriminatedUnion("humanAuthMode", [
  z.object({
    socketPath: privateSocketPath,
    serviceToken: z.string().min(32),
    delegatedJwtKey: DelegatedJwtKeySchema,
    humanAuthMode: z.literal("oidc"),
    oidc: z.object({
      issuer: httpsUrl,
      audience: z.string().min(1),
      jwksUri: httpsUrl,
    }).strict(),
  }).strict(),
  z.object({
    socketPath: privateSocketPath,
    serviceToken: z.string().min(32),
    delegatedJwtKey: DelegatedJwtKeySchema,
    humanAuthMode: z.literal("tailscale-localapi"),
    tailscale: z.object({
      trustedProxyCidr,
      localApiSocketPath: privateSocketPath,
      allowedUsers: connectorAllowedUsersSchema,
    }).strict(),
  }).strict(),
]);

export type HumanAuthMode = "tailscale-localapi" | "oidc";
export type ConnectorsConfig = z.infer<typeof ConnectorsConfigSchema>;

const connectorEnvironmentKeys = [
  "CONNECTORS_SOCKET_PATH",
  "CONNECTORS_SERVICE_TOKEN",
  "CONNECTORS_DELEGATED_JWT_KEY",
  "CONNECTORS_HUMAN_AUTH_MODE",
  "CONNECTORS_OIDC_ISSUER",
  "CONNECTORS_OIDC_AUDIENCE",
  "CONNECTORS_OIDC_JWKS_URI",
  "CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR",
  "CONNECTORS_TAILSCALE_LOCALAPI_SOCKET",
  "CONNECTORS_TAILSCALE_ALLOWED_USERS",
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

const loadConnectorsConfig = (environment: Environment): ConnectorsConfig | undefined => {
  const hasSettings = connectorEnvironmentKeys.some((key) => environment[key] !== undefined);
  const enabled = environment.CONNECTORS_ENABLED;
  if (enabled === undefined) {
    if (hasSettings) throw new Error("Connector settings require CONNECTORS_ENABLED=true.");
    return undefined;
  }
  if (enabled !== "true" && enabled !== "false") {
    throw new Error("CONNECTORS_ENABLED must be true or false.");
  }
  if (enabled === "false") {
    if (hasSettings) throw new Error("Connector settings cannot be supplied while connectors are disabled.");
    return undefined;
  }

  const humanAuthMode = environment.CONNECTORS_HUMAN_AUTH_MODE;
  if (humanAuthMode !== "oidc" && humanAuthMode !== "tailscale-localapi") {
    throw new Error("CONNECTORS_HUMAN_AUTH_MODE must select exactly one supported mode.");
  }
  const hasOidcSettings = [
    environment.CONNECTORS_OIDC_ISSUER,
    environment.CONNECTORS_OIDC_AUDIENCE,
    environment.CONNECTORS_OIDC_JWKS_URI,
  ].some((value) => value !== undefined);
  const hasTailscaleSettings = [
    environment.CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR,
    environment.CONNECTORS_TAILSCALE_LOCALAPI_SOCKET,
    environment.CONNECTORS_TAILSCALE_ALLOWED_USERS,
  ].some((value) => value !== undefined);
  if ((humanAuthMode === "oidc" && hasTailscaleSettings) || (humanAuthMode === "tailscale-localapi" && hasOidcSettings)) {
    throw new Error("Connector human-auth settings cannot mix modes.");
  }

  const common = {
    socketPath: environment.CONNECTORS_SOCKET_PATH ?? defaultConnectorsSocketPath,
    serviceToken: environment.CONNECTORS_SERVICE_TOKEN,
    delegatedJwtKey: environment.CONNECTORS_DELEGATED_JWT_KEY,
    humanAuthMode,
  };
  if (humanAuthMode === "oidc") {
    return ConnectorsConfigSchema.parse({
      ...common,
      oidc: {
        issuer: environment.CONNECTORS_OIDC_ISSUER,
        audience: environment.CONNECTORS_OIDC_AUDIENCE,
        jwksUri: environment.CONNECTORS_OIDC_JWKS_URI,
      },
    });
  }
  return ConnectorsConfigSchema.parse({
    ...common,
    tailscale: {
      trustedProxyCidr: environment.CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR,
      localApiSocketPath: environment.CONNECTORS_TAILSCALE_LOCALAPI_SOCKET,
      allowedUsers: parseConnectorsAllowedUsers(environment.CONNECTORS_TAILSCALE_ALLOWED_USERS),
    },
  });
};

const ServerConfigSchema = z
  .object({
    authMode: z.enum(["oidc", "tailscale"]),
    internalAuthKey: z.string().min(32).optional(),
    tailscaleAllowedUsers: z.record(z.string(), z.uuid()).optional(),
    maxUploadBodyBytes: z.number().int().min(1_024).max(104_857_600),
    maxConcurrentAgentOperations: z.number().int().min(1).max(16),
    upstreamTimeoutMs: z.number().int().min(100).max(60_000),
    agentRequestsPerMinute: z.number().int().min(0).max(10_000),
    pihApiInternalUrl: uncredentialedHttpUrl,
    publicOrigin: uncredentialedHttpUrl.transform((value, context) => {
      const url = new URL(value);
      if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
        context.addIssue({
          code: "custom",
          message: "Expected an origin without a path, query, or fragment.",
        });
        return z.NEVER;
      }
      return url.origin;
    }),
    hermesInternalUrl: uncredentialedHttpUrl.optional(),
    hermesServiceToken: z.string().min(1).optional(),
    hermesDashboardUrl: uncredentialedHttpUrl.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.authMode === "tailscale" &&
      (value.internalAuthKey === undefined ||
        value.tailscaleAllowedUsers === undefined ||
        Object.keys(value.tailscaleAllowedUsers).length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Tailscale mode requires an internal key and at least one allowed user.",
      });
    }
    if (
      (value.hermesInternalUrl === undefined) !==
      (value.hermesServiceToken === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Hermes URL and token must be configured together.",
      });
    }
  });

export type ServerConfig = z.infer<typeof ServerConfigSchema> & Readonly<{
  connectors?: ConnectorsConfig;
}>;

export const loadServerConfig = (
  environment: Environment = process.env,
): ServerConfig => {
  const existing = ServerConfigSchema.parse({
    authMode: environment.AUTH_MODE ?? "oidc",
    internalAuthKey: environment.PIH_INTERNAL_AUTH_KEY,
    tailscaleAllowedUsers: parseAllowedUsers(environment.TAILSCALE_ALLOWED_USERS),
    maxUploadBodyBytes: Number(
      environment.MAX_UPLOAD_BODY_BYTES ?? "10485760",
    ),
    maxConcurrentAgentOperations: Number(
      environment.MAX_CONCURRENT_AGENT_OPERATIONS ?? "2",
    ),
    upstreamTimeoutMs: Number(environment.UPSTREAM_TIMEOUT_MS ?? "5000"),
    agentRequestsPerMinute: Number(
      environment.AGENT_REQUESTS_PER_MINUTE ?? "0",
    ),
    pihApiInternalUrl:
      environment.PIH_API_INTERNAL_URL ?? defaultApiInternalUrl,
    publicOrigin: environment.PUBLIC_ORIGIN ?? defaultPublicOrigin,
    hermesInternalUrl: environment.HERMES_INTERNAL_URL,
    hermesServiceToken: environment.HERMES_SERVICE_TOKEN,
    hermesDashboardUrl: environment.HERMES_DASHBOARD_URL,
  });
  const connectors = loadConnectorsConfig(environment);
  if (connectors === undefined) return existing;
  if (connectors.humanAuthMode === "tailscale-localapi" && existing.internalAuthKey === undefined) {
    throw new Error("Tailscale connector identity requires PIH_INTERNAL_AUTH_KEY for the existing PIH API authorization.");
  }
  if (existing.internalAuthKey !== undefined && Buffer.from(existing.internalAuthKey, "utf8").equals(Buffer.from(connectors.delegatedJwtKey))) {
    throw new Error("The connectors delegated JWT key must be distinct from the Second Brain key.");
  }
  return { ...existing, connectors };
};

export const serverConfig = Object.freeze(loadServerConfig());
