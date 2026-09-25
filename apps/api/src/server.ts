import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { OidcJwtAuthenticator } from "./adapters/auth/oidc-jwt-authenticator.js";
import { TailscaleInternalAuthenticator } from "./adapters/auth/tailscale-internal-authenticator.js";
import { HmacCursorCodec } from "./adapters/cursors/hmac-cursor-codec.js";
import { buildApp } from "./app.js";
import type { Authenticator } from "./application/ports/authenticator.js";
import type { QueryPorts } from "./application/ports/queries.js";
import type { UnitOfWork } from "./application/ports/unit-of-work.js";
import { buildPublicConfig, type PublicConfigSource } from "./config/public.js";
import {
  loadPrivateConfig,
  type PrivateConfig,
} from "./config/private.js";
import type { ReadinessCheck } from "./routes/health.js";
import type { SynchronizationDependencies } from "./routes/events.js";

export type ServerDependencies = Readonly<{
  unitOfWork: UnitOfWork;
  queries: QueryPorts;
  readinessCheck: ReadinessCheck;
  publicConfig: PublicConfigSource;
  clock?: () => Date;
  synchronization?: SynchronizationDependencies;
}>;

export const createAuthenticator = (
  config: PrivateConfig,
  clock: () => Date,
): Authenticator =>
  config.authMode === "tailscale"
    ? new TailscaleInternalAuthenticator({
        signingKey: config.internalAuthKey,
        clock,
      })
    : new OidcJwtAuthenticator({
        issuer: config.oidcIssuer,
        audience: config.oidcAudience,
        jwksUri: config.oidcJwksUri,
        algorithms: config.oidcAlgorithms,
        clock,
      });

export const createServer = (
  config: PrivateConfig,
  dependencies: ServerDependencies,
): FastifyInstance => {
  const clock = dependencies.clock ?? (() => new Date());
  return buildApp({
    authenticator: createAuthenticator(config, clock),
    cursorCodec: new HmacCursorCodec(config.cursorSigningKey),
    unitOfWork: dependencies.unitOfWork,
    queries: dependencies.queries,
    readinessCheck: dependencies.readinessCheck,
    clock,
    requestIdFactory: randomUUID,
    publicConfig: buildPublicConfig(dependencies.publicConfig),
    runtime: config.nodeEnv,
    logger: { level: config.logLevel },
    allowedOrigins: config.allowedOrigins,
    ...(dependencies.synchronization === undefined
      ? {}
      : { synchronization: dependencies.synchronization }),
  });
};

export const listen = async (
  app: FastifyInstance,
  config: Pick<PrivateConfig, "host" | "port">,
): Promise<void> => {
  await app.listen({ host: config.host, port: config.port });
};

export const startServer = async (
  dependencies: ServerDependencies,
  config: PrivateConfig = loadPrivateConfig(),
): Promise<FastifyInstance> => {
  const app = createServer(config, dependencies);
  await listen(app, config);
  return app;
};
