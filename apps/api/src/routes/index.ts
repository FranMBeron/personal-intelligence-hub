import type { FastifyInstance } from "fastify";

import { registerAuditRoutes } from "./audit.js";
import { registerBoardRoutes } from "./boards.js";
import { registerCardRoutes } from "./cards.js";
import { registerRelationRoutes } from "./relations.js";
import { registerTaskRoutes } from "./tasks.js";

export const registerSecondBrainRoutes = (app: FastifyInstance): void => {
  registerBoardRoutes(app);
  registerCardRoutes(app);
  registerRelationRoutes(app);
  registerTaskRoutes(app);
  registerAuditRoutes(app);
};
