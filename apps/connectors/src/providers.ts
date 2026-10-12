import type { ProviderConfigNamespace } from "./config/provider-namespace.js";
import type { ProviderModuleFactory } from "./foundation/module.js";

export const providerConfigNamespaces: readonly ProviderConfigNamespace<string, unknown>[] =
  Object.freeze([]);

export const providerModules: readonly ProviderModuleFactory[] = Object.freeze([]);
