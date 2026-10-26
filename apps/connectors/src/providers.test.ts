import { describe, expect, it } from "vitest";

import { calendarConfigNamespace, calendarProviderModule } from "./calendar/index.js";
import { providerConfigNamespaces, providerModules } from "./providers.js";

describe("provider extension points", () => {
  it("registers the reviewed provider namespaces and factories in immutable lists", () => {
    expect(providerConfigNamespaces).toEqual([calendarConfigNamespace]);
    expect(providerModules).toEqual([calendarProviderModule]);
    expect(Object.isFrozen(providerConfigNamespaces)).toBe(true);
    expect(Object.isFrozen(providerModules)).toBe(true);
  });
});
