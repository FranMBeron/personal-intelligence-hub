import { calendarConfigNamespace, calendarProviderModule } from "./calendar/index.js";
import type { ProviderConfigNamespace } from "./config/provider-namespace.js";
import type { ProviderModuleFactory } from "./foundation/module.js";

export const providerConfigNamespaces: readonly ProviderConfigNamespace<string, unknown>[] =
  Object.freeze([calendarConfigNamespace as ProviderConfigNamespace<string, unknown>]);

export const providerModules: readonly ProviderModuleFactory[] = Object.freeze([calendarProviderModule]);
