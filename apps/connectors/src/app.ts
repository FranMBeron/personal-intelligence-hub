import {
  SourceStatusSchema,
  type SourceStatus,
} from "@personal-intelligence-hub/contracts";
import fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import { randomUUID } from "node:crypto";

import { installConnectorAuthentication, requireScope, requireService } from "./foundation/auth.js";
import type { ConnectorDatabase } from "./foundation/database.js";
import type { ConnectorModule, ConnectorModuleDependencies } from "./foundation/module.js";
import { preferencesConnectorModule } from "./preferences/routes.js";

const BODY_LIMIT_BYTES = 1_048_576;
// Source health checks are lightweight; one stalled adapter must not hold either endpoint.
export const MODULE_STATUS_PROBE_TIMEOUT_MS = 1_000;

export type ConnectorsAppDependencies = ConnectorModuleDependencies & Readonly<{
  modules: readonly ConnectorModule[];
  requestIdFactory?: () => string;
  logger?: boolean | Readonly<{ level?: string }>;
}>;

const assertUniqueModuleNames = (modules: readonly ConnectorModule[]): void => {
  const names = new Set<string>();
  for (const module of modules) {
    if (typeof module.name !== "string" || module.name.length === 0 || module.name.trim() !== module.name) {
      throw new Error("Connector module names must be non-empty and trimmed");
    }
    if (names.has(module.name)) throw new Error("Connector module names must be unique");
    names.add(module.name);
  }
};

const safeUnavailable = (name: string, now: Date): SourceStatus => SourceStatusSchema.parse({
  id: name,
  state: "unavailable",
  checkedAt: now.toISOString(),
  stale: false,
  capabilities: [],
  safeReasonCode: "probe_failed",
});

const getSourceStatuses = async (
  modules: readonly ConnectorModule[],
  dependencies: ConnectorModuleDependencies,
): Promise<readonly SourceStatus[]> => {
  const statuses = await Promise.all(modules.map(async (module) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const probe = Promise.resolve().then(() => module.status(dependencies));
      const timeoutError = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Connector module status probe timed out")),
          MODULE_STATUS_PROBE_TIMEOUT_MS,
        );
      });
      const candidate: unknown = await Promise.race([probe, timeoutError]);
      const parsed = SourceStatusSchema.parse(candidate);
      if (parsed.id !== module.name) throw new Error("Source ID mismatch");
      return parsed;
    } catch {
      return safeUnavailable(module.name, dependencies.clock.now());
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }));
  return statuses.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
};

const readiness = async (
  database: ConnectorDatabase,
  modules: readonly ConnectorModule[],
  dependencies: ConnectorModuleDependencies,
): Promise<Readonly<{ database: boolean; migrations: boolean; modules: boolean }>> => {
  let databaseReady = false;
  let migrationsReady = false;
  try {
    const names = await database.read((handle) => {
      handle.prepare("SELECT 1 AS alive").get();
      return handle.prepare(
        "SELECT name FROM connector_migrations ORDER BY name",
      ).all<{ name: string }>();
    });
    databaseReady = true;
    migrationsReady = names.length > 0;
  } catch {
    // Readiness responses intentionally expose only booleans.
  }
  const sources = await getSourceStatuses(modules, dependencies);
  const modulesReady = sources.every((source) =>
    source.state !== "unavailable" && source.state !== "requires_attention",
  );
  return Object.freeze({ database: databaseReady, migrations: migrationsReady, modules: modulesReady });
};

export const createConnectorsApp = async (
  dependencies: ConnectorsAppDependencies,
): Promise<FastifyInstance> => {
  assertUniqueModuleNames(dependencies.modules);
  const requestIdFactory = dependencies.requestIdFactory ?? randomUUID;
  const app = fastify<RawServerDefault>({
    logger: dependencies.logger ?? false,
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: () => requestIdFactory(),
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const moduleDependencies: ConnectorModuleDependencies = Object.freeze({
    config: dependencies.config,
    database: dependencies.database,
    clock: Object.freeze({ now: () => new Date(dependencies.clock.now()) }),
    idGenerator: Object.freeze({ generate: () => dependencies.idGenerator.generate() }),
  });
  installConnectorAuthentication(app, dependencies.config, {
    requestIdFactory: (request) => request.id,
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (request, reply) => {
    requireScope(request, "health:read");
    requireService(request, ["pih-deployer"]);
    const checks = await readiness(dependencies.database, dependencies.modules, moduleDependencies);
    const ready = checks.database && checks.migrations && checks.modules;
    if (!ready) reply.code(503);
    return { status: ready ? "ready" : "not_ready", ...checks };
  });

  app.get("/v1/system/status", async (request) => {
    requireScope(request, "system:read");
    requireService(request, ["pih-web"]);
    return { sources: await getSourceStatuses(dependencies.modules, moduleDependencies) };
  });

  try {
    await app.register(preferencesConnectorModule, {
      config: dependencies.config,
      database: dependencies.database,
    });
    for (const module of dependencies.modules) {
      await module.register(app, moduleDependencies);
    }
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
};
