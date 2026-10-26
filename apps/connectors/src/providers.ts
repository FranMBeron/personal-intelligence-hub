import { calendarConfigNamespace, calendarProviderModule } from "./calendar/index.js";
import type { ProviderConfigNamespace } from "./config/provider-namespace.js";
import { deviceConnectionsConfigNamespace, deviceConnectionsProviderModule } from "./devices/index.js";
import type { ProviderModuleFactory } from "./foundation/module.js";
import { hermesConfigNamespace, hermesProviderModule } from "./hermes/module.js";

export const providerConfigNamespaces: readonly ProviderConfigNamespace<string, unknown>[] =
  Object.freeze([
    calendarConfigNamespace,
    hermesConfigNamespace,
    deviceConnectionsConfigNamespace,
  ] as ProviderConfigNamespace<string, unknown>[]);

export const providerModules: readonly ProviderModuleFactory[] = Object.freeze([
  calendarProviderModule,
  hermesProviderModule,
  deviceConnectionsProviderModule,
]);
