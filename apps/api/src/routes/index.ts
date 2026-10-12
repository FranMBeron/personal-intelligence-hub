import type { FastifyInstance } from "fastify";

import { registerAuditRoutes } from "./audit.js";
import { registerBoardRoutes } from "./boards.js";
import { registerCardRoutes } from "./cards.js";
import { registerRelationRoutes } from "./relations.js";
import { registerTaskRoutes } from "./tasks.js";
import {
  registerEventRoute,
  type SynchronizationDependencies,
} from "./events.js";
import { registerSnapshotRoute } from "./snapshot.js";

export const registerSecondBrainRoutes = (
  app: FastifyInstance,
  synchronization?: SynchronizationDependencies,
): void => {
  registerBoardRoutes(app);
  registerCardRoutes(app);
  registerRelationRoutes(app);
  registerTaskRoutes(app);
  registerAuditRoutes(app);
  registerSnapshotRoute(app);
  if (synchronization !== undefined) {
    registerEventRoute(app, synchronization);
  }
};
