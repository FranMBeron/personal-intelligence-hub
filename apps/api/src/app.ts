import cors from "@fastify/cors";
import fastify, {
  type FastifyInstance,
} from "fastify";

import type { Authenticator } from "./application/ports/authenticator.js";
import type { CursorCodec } from "./application/ports/cursor-codec.js";
import type { QueryPorts } from "./application/ports/queries.js";
import type { UnitOfWork } from "./application/ports/unit-of-work.js";
import type { PublicConfig } from "./config/public.js";
import { installErrorHandler } from "./errors.js";
import { installAuthentication } from "./plugins/auth.js";
import { registerOpenApi } from "./plugins/openapi.js";
import {
  installRequestContext,
  type RequestIdFactory,
} from "./plugins/request-context.js";
import {
  registerHealthRoutes,
  type ReadinessCheck,
} from "./routes/health.js";
import { registerPublicConfigRoute } from "./routes/public-config.js";

export type RuntimeEnvironment = "development" | "test" | "production";

export type AppLoggerOptions =
  | boolean
  | Readonly<{
      level?: string;
    }>;

export type AppDependencies = Readonly<{
  authenticator: Authenticator;
  cursorCodec: CursorCodec;
  unitOfWork: UnitOfWork;
  queries: QueryPorts;
  readinessCheck: ReadinessCheck;
  clock: () => Date;
  requestIdFactory: RequestIdFactory;
  publicConfig: PublicConfig;
  runtime: RuntimeEnvironment;
  logger?: AppLoggerOptions;
  allowedOrigins?: readonly string[];
}>;

declare module "fastify" {
  interface FastifyInstance {
    pihDependencies: Readonly<{
      cursorCodec: CursorCodec;
      unitOfWork: UnitOfWork;
      queries: QueryPorts;
      clock: () => Date;
    }>;
  }
}

const redactionPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "authorization",
  "cookie",
  "*.password",
  "*.secret",
  "*.token",
  "*.apiKey",
  "*.cursorSigningKey",
  "*.databaseUrl",
];

export const createLoggerOptions = (level = "info") => ({
  level,
  redact: {
    paths: [...redactionPaths],
    censor: "[Redacted]",
  },
});

const resolveLoggerOptions = (logger: AppLoggerOptions | undefined) => {
  if (logger === false) {
    return false;
  }
  if (logger === true || logger === undefined) {
    return createLoggerOptions();
  }
  return createLoggerOptions(logger.level);
};

export const buildApp = (dependencies: AppDependencies): FastifyInstance => {
  if (
    dependencies.runtime === "production" &&
    dependencies.authenticator.kind === "test"
  ) {
    throw new Error("Test authenticators are forbidden in production.");
  }

  const app = fastify({ logger: resolveLoggerOptions(dependencies.logger) });
  app.decorate("pihDependencies", {
    cursorCodec: dependencies.cursorCodec,
    unitOfWork: dependencies.unitOfWork,
    queries: dependencies.queries,
    clock: dependencies.clock,
  });

  registerOpenApi(app);
  if (dependencies.allowedOrigins !== undefined) {
    void app.register(cors, {
      origin: [...dependencies.allowedOrigins],
      credentials: true,
    });
  }
  installRequestContext(app, dependencies.requestIdFactory);
  installAuthentication(app, dependencies.authenticator);
  installErrorHandler(app);
  app.setNotFoundHandler(async () => {
    const { NotFoundError } = await import("./application/errors.js");
    throw new NotFoundError();
  });
  registerHealthRoutes(app, dependencies.readinessCheck);
  registerPublicConfigRoute(app, dependencies.publicConfig);

  return app;
};
