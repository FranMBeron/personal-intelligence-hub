import type { FastifyInstance } from "fastify";
import { inspect } from "node:util";

import type { ProviderConfigNamespace } from "../config/provider-namespace.js";
import type { ConnectorModule, ConnectorModuleDependencies, ProviderModuleFactory } from "../foundation/module.js";
import { loadHermesConfig } from "./config.js";
import { loadDelegationPeerConfig } from "./delegation-auth.js";
import { HERMES_SOURCE_ID, notConfiguredHermesStatus, probeHermesStatus } from "./health.js";
import { HermesProfileRegistry } from "./profile-registry.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerCapabilitiesRoutes } from "./routes/capabilities.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerDelegationRoutes } from "./routes/delegations.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { installHermesProblemHandler } from "./routes/problems.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { createHermesRuntime, type HermesModuleOptions, type HermesRuntime } from "./runtime.js";

export { probeHermesStatus } from "./health.js";
export type { HermesModuleOptions } from "./runtime.js";

export type HermesRuntimeFactory = (dependencies: ConnectorModuleDependencies) => HermesRuntime;

declare module "../config/private.js" {
  interface ProviderRuntimeConfig {
    hermes?: HermesModuleOptions;
  }
}

/**
 * The Hermes connectors module: BFF routes on the Foundation app (web service
 * only), plus, when delegation is configured, the agent-only delegation server
 * on its own Unix socket. Workers start after the app is ready and stop in
 * reverse order on close; startup never awaits a worker's lifetime.
 */
export const createHermesModule = (
  options: HermesModuleOptions,
  createRuntime: HermesRuntimeFactory = (dependencies) => createHermesRuntime(options, dependencies),
): ConnectorModule => Object.freeze<ConnectorModule>({
  name: HERMES_SOURCE_ID,
  async register(app: FastifyInstance, dependencies: ConnectorModuleDependencies) {
    const runtime = createRuntime(dependencies);
    let started = false;
    // Registered before any await so a later registration failure still halts and drains workers.
    app.addHook("preClose", async () => { runtime.streamAbort.abort(); });
    app.addHook("onClose", async () => {
      runtime.abort.abort();
      runtime.streamAbort.abort();
      if (!started) return;
      await runtime.maintenance.stop();
      await runtime.delegationReconciler.stop();
      await runtime.reconciler.stop();
      await runtime.delegationServer?.stop();
    });
    await runtime.initialize();
    await app.register(async (scope) => {
      installHermesProblemHandler(scope);
      await registerCapabilitiesRoutes(scope, runtime.routes);
      await registerAgentRoutes(scope, runtime.routes);
      await registerConversationRoutes(scope, runtime.routes);
      await registerMessageRoutes(scope, runtime.routes);
      await registerUploadRoutes(scope, runtime.routes);
      await registerDelegationRoutes(scope, runtime.routes);
    });
    app.addHook("onReady", async () => {
      started = true;
      // Reserved admissions are resumed by the maintenance loop's first (immediate) tick, so
      // startup never waits on upstream calls for a backlog.
      await runtime.delegationServer?.start();
      await runtime.reconciler.start(runtime.abort.signal);
      await runtime.delegationReconciler.start(runtime.abort.signal);
      await runtime.maintenance.start(runtime.abort.signal);
    });
  },
  status: (dependencies) => probeHermesStatus(options.config, dependencies.clock, options.fetch),
});

const CORE_VARIABLES = ["HERMES_API_ORIGIN", "HERMES_DEFAULT_PROFILE_ID", "HERMES_PROFILES_JSON"] as const;
const DELEGATION_VARIABLES = [
  "HERMES_DELEGATION_ORCHESTRATOR_ID",
  "HERMES_DELEGATION_SOCKET_PATH",
  "HERMES_DELEGATION_SOCKET_GROUP_ID",
  "HERMES_DELEGATION_PEERS_JSON",
] as const;

const parseHermesEnvironment = (environment: Readonly<Record<string, string | undefined>>): HermesModuleOptions | undefined => {
  const configured = [...CORE_VARIABLES, ...DELEGATION_VARIABLES].some((key) => environment[key] !== undefined);
  if (!configured) return undefined;
  const config = loadHermesConfig(environment);
  const delegationConfigured = DELEGATION_VARIABLES.some((key) => environment[key] !== undefined);
  // Any delegation variable opts in, and then the complete set is validated (fail closed on partial configuration).
  const delegation = delegationConfigured ? loadDelegationPeerConfig(environment, new HermesProfileRegistry(config)) : undefined;
  const options = { config, ...(delegation === undefined ? {} : { delegation }) };
  Object.defineProperty(options, inspect.custom, {
    value: () => `HermesModuleOptions ${JSON.stringify({ config, delegation: delegation === undefined ? null : "[REDACTED]" })}`,
    enumerable: false,
  });
  return Object.freeze(options);
};

/** Provider configuration namespace: `config.hermes` is present only when Hermes variables are set. */
export const hermesConfigNamespace: ProviderConfigNamespace<"hermes", HermesModuleOptions> = Object.freeze({
  name: "hermes" as const,
  parse: parseHermesEnvironment,
});

const unconfiguredModule = (): ConnectorModule => Object.freeze<ConnectorModule>({
  name: HERMES_SOURCE_ID,
  async register() {
    // No Hermes route is served without configuration.
  },
  status: async (dependencies) => notConfiguredHermesStatus(dependencies.clock),
});

export const createHermesProviderModule = (dependencies: ConnectorModuleDependencies): ConnectorModule => {
  const options = dependencies.config.hermes;
  return options === undefined ? unconfiguredModule() : createHermesModule(options);
};

export const hermesProviderModule: ProviderModuleFactory = Object.freeze({
  name: HERMES_SOURCE_ID,
  create: createHermesProviderModule,
});
