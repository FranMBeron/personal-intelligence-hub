import type { FastifyInstance } from "fastify";

import { readRouteSchema } from "./shared.js";

export const registerSnapshotRoute = (app: FastifyInstance): void => {
  app.get(
    "/v1/snapshot",
    {
      config: { pihSecurity: { scopes: ["second-brain:read"] } },
      schema: readRouteSchema({ responseRef: "Snapshot" }),
    },
    async (request) => request.server.pihDependencies.queries.snapshot.get(),
  );
};
