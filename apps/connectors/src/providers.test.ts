import { describe, expect, it } from "vitest";

import { calendarConfigNamespace, calendarProviderModule } from "./calendar/index.js";
import { deviceConnectionsConfigNamespace, deviceConnectionsProviderModule } from "./devices/index.js";
import { hermesConfigNamespace, hermesProviderModule } from "./hermes/module.js";
import { providerConfigNamespaces, providerModules } from "./providers.js";

describe("provider extension points", () => {
  it("registers the reviewed provider namespaces and factories in immutable lists", () => {
    expect(providerConfigNamespaces).toEqual([calendarConfigNamespace, hermesConfigNamespace, deviceConnectionsConfigNamespace]);
    expect(providerModules).toEqual([calendarProviderModule, hermesProviderModule, deviceConnectionsProviderModule]);
    expect(Object.isFrozen(providerConfigNamespaces)).toBe(true);
    expect(Object.isFrozen(providerModules)).toBe(true);
  });
});
