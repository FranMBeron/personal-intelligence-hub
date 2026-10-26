import {
  UpdateUserPreferencesBodySchema,
  type UpdateUserPreferencesBody,
} from "@personal-intelligence-hub/contracts";
import type { FastifyPluginAsync } from "fastify";

import type { ConnectorsConfig } from "../config/private.js";
import { requireScope } from "../foundation/auth.js";
import type { ConnectorDatabase } from "../foundation/database.js";
import { ConnectorProblem } from "../foundation/problems.js";
import { createPreferencesRepository, PreferencesVersionConflict } from "./repository.js";

export type PreferencesConnectorOptions = Readonly<{
  config: ConnectorsConfig;
  database: ConnectorDatabase;
}>;

const publicPreferences = (value: { timeZone: string; version: number }) => ({
  timeZone: value.timeZone,
  version: value.version,
});

export const preferencesConnectorModule: FastifyPluginAsync<PreferencesConnectorOptions> = async (
  app,
  { config, database },
) => {
  const repository = createPreferencesRepository(database);

  app.get("/v1/preferences", async (request) => {
    const principal = requireScope(request, "preferences:read");
    if (principal.serviceId !== "pih-web" || principal.actorType !== "human") {
      throw new ConnectorProblem("forbidden", 403);
    }
    return publicPreferences(await repository.get(principal.actorId, config.defaultTimeZone));
  });

  app.patch<{ Body: UpdateUserPreferencesBody }>("/v1/preferences", async (request) => {
    const principal = requireScope(request, "preferences:write");
    if (principal.serviceId !== "pih-web" || principal.actorType !== "human") {
      throw new ConnectorProblem("forbidden", 403);
    }
    const parsed = UpdateUserPreferencesBodySchema.safeParse(request.body);
    if (!parsed.success) throw new ConnectorProblem("validation_failed", 400);
    try {
      return publicPreferences(await repository.update({
        actorId: principal.actorId,
        timeZone: parsed.data.timeZone,
        expectedVersion: parsed.data.expectedVersion,
      }));
    } catch (error) {
      if (error instanceof PreferencesVersionConflict) {
        throw new ConnectorProblem("version_conflict", 409);
      }
      throw error;
    }
  });
};
