import "server-only";

import { z } from "zod";

const defaultApiInternalUrl = "http://127.0.0.1:3001";

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
    pihApiInternalUrl: uncredentialedHttpUrl,
    hermesInternalUrl: uncredentialedHttpUrl.optional(),
    hermesServiceToken: z.string().min(1).optional(),
    hermesDashboardUrl: uncredentialedHttpUrl.optional(),
  })
  .strict()
  .superRefine((value, context) => {
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
    pihApiInternalUrl:
      environment.PIH_API_INTERNAL_URL ?? defaultApiInternalUrl,
    hermesInternalUrl: environment.HERMES_INTERNAL_URL,
    hermesServiceToken: environment.HERMES_SERVICE_TOKEN,
    hermesDashboardUrl: environment.HERMES_DASHBOARD_URL,
  });

export const serverConfig = Object.freeze(loadServerConfig());
