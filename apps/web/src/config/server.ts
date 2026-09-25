import "server-only";

import { z } from "zod";

const defaultApiInternalUrl = "http://127.0.0.1:3001";
const defaultPublicOrigin = "http://127.0.0.1:3000";

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

const ServerConfigSchema = z
  .object({
    authMode: z.enum(["oidc", "tailscale"]),
    internalAuthKey: z.string().min(32).optional(),
    tailscaleAllowedUsers: z.record(z.string(), z.uuid()).optional(),
    pihApiInternalUrl: uncredentialedHttpUrl,
    publicOrigin: uncredentialedHttpUrl.transform((value, context) => {
      const url = new URL(value);
      if (
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
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

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const loadServerConfig = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ServerConfig =>
  ServerConfigSchema.parse({
    authMode: environment.AUTH_MODE ?? "oidc",
    internalAuthKey: environment.PIH_INTERNAL_AUTH_KEY,
    tailscaleAllowedUsers: parseAllowedUsers(environment.TAILSCALE_ALLOWED_USERS),
    pihApiInternalUrl:
      environment.PIH_API_INTERNAL_URL ?? defaultApiInternalUrl,
    publicOrigin: environment.PUBLIC_ORIGIN ?? defaultPublicOrigin,
    hermesInternalUrl: environment.HERMES_INTERNAL_URL,
    hermesServiceToken: environment.HERMES_SERVICE_TOKEN,
    hermesDashboardUrl: environment.HERMES_DASHBOARD_URL,
  });

export const serverConfig = Object.freeze(loadServerConfig());
