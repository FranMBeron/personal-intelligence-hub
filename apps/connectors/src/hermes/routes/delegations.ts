import { DelegationListSchema, DelegationSchema } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";

import type { HermesRouteServices } from "../runtime.js";
import { authorize, noQuery, pathRefs, queryOf } from "./http.js";

/** Read-only delegation ledger for the authenticated owner. The agent-only start operation is never served here. */
export const registerDelegationRoutes = async (app: FastifyInstance, services: HermesRouteServices): Promise<void> => {
  app.get("/v1/delegations", async (request) => {
    const principal = authorize(request, "hermes:delegations:read");
    return DelegationListSchema.parse(await services.delegations.list(principal, queryOf(request)));
  });

  app.get("/v1/delegations/:id", async (request) => {
    const principal = authorize(request, "hermes:delegations:read");
    const { id } = pathRefs(request, "id");
    noQuery(request);
    return DelegationSchema.parse(await services.delegations.get(principal, id));
  });
};
