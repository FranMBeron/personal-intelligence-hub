import { describe, expect, it } from "vitest";

import { providerConfigNamespaces, providerModules } from "./providers.js";

describe("provider extension points", () => {
  it("starts with immutable empty namespace and factory lists", () => {
    expect(providerConfigNamespaces).toEqual([]);
    expect(providerModules).toEqual([]);
    expect(Object.isFrozen(providerConfigNamespaces)).toBe(true);
    expect(Object.isFrozen(providerModules)).toBe(true);
  });
});
