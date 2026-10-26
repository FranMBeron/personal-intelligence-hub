import { HermesCapabilitiesSchema } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";

import type { HermesRouteServices } from "../runtime.js";
import { authorize, noQuery } from "./http.js";

export const registerCapabilitiesRoutes = async (app: FastifyInstance, services: HermesRouteServices): Promise<void> => {
  app.get("/v1/capabilities", async (request) => {
    authorize(request, "hermes:agents:read");
    noQuery(request);
    return HermesCapabilitiesSchema.parse(await services.health.capabilities(services.imageMaxBytes));
  });
};
