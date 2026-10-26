import { AgentSummarySchema } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { HermesRouteServices } from "../runtime.js";
import { authorize, noQuery } from "./http.js";

const AgentListSchema = z.array(AgentSummarySchema);

export const registerAgentRoutes = async (app: FastifyInstance, services: HermesRouteServices): Promise<void> => {
  app.get("/v1/agents", async (request) => {
    authorize(request, "hermes:agents:read");
    noQuery(request);
    return AgentListSchema.parse(await services.health.agents());
  });
};
