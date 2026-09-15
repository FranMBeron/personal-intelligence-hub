import type { FastifyInstance } from "fastify";

import {
  sanitizePublicConfig,
  type PublicConfig,
} from "../config/public.js";
import { readRouteSchema } from "./shared.js";

export const registerPublicConfigRoute = (
  app: FastifyInstance,
  config: PublicConfig,
): void => {
  const safeConfig = sanitizePublicConfig(config);
  app.get(
    "/v1/config/public",
    {
      config: { pihSecurity: { scopes: ["second-brain:read"] } },
      schema: readRouteSchema({ responseRef: "PublicConfig" }),
    },
    async () => safeConfig,
  );
};
