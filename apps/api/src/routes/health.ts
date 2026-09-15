import type { FastifyInstance } from "fastify";

import { DependencyUnavailableError } from "../application/errors.js";

export type ReadinessStatus = Readonly<{ status: "ready" }>;
export type ReadinessCheck = () => Promise<ReadinessStatus>;

export const registerHealthRoutes = (
  app: FastifyInstance,
  readinessCheck: ReadinessCheck,
): void => {
  app.get(
    "/health/live",
    { schema: { security: [] } },
    async () => ({ status: "ok" }),
  );

  app.get(
    "/health/ready",
    {
      config: { pihSecurity: { scopes: ["second-brain:read"] } },
    },
    async () => {
      try {
        return await readinessCheck();
      } catch (error) {
        throw new DependencyUnavailableError(error);
      }
    },
  );
};
