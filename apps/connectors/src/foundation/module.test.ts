import { describe, expect, it, vi } from "vitest";

import type { ConnectorsConfig } from "../config/private.js";
import type { ConnectorDatabase } from "./database.js";
import type { ConnectorModule, ConnectorModuleDependencies } from "./module.js";
import { createConnectorsApp } from "../app.js";
import { providerConfigNamespaces, providerModules } from "../providers.js";

const testDependencies = (modules: ConnectorModule[]) => {
  const config: ConnectorsConfig = {
    transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
    databasePath: "/tmp/connectors-test.sqlite",
    serviceCredentials: [],
    audience: "personal-intelligence-hub-connectors",
    defaultTimeZone: "Etc/UTC",
    logLevel: "error",
  };
  const base: ConnectorModuleDependencies = Object.freeze({
    config,
    database: {} as ConnectorDatabase,
    clock: { now: () => new Date("2026-10-12T12:00:00.000Z") },
    idGenerator: { generate: () => "test-id" },
  });
  return { ...base, modules, requestIdFactory: () => "test-request-id", logger: false };
};

const testModule = (name: string): ConnectorModule => ({
  name,
  register: async () => undefined,
  status: async () => ({
    id: name,
    state: "available",
    checkedAt: "2026-10-12T12:00:00.000Z",
    stale: false,
    capabilities: [],
  }),
});

describe("connector module registry", () => {
  it("registers each module once in supplied order", async () => {
    const calls: string[] = [];
    const modules: ConnectorModule[] = [
      { ...testModule("one"), register: async () => { calls.push("one"); } },
      { ...testModule("two"), register: async () => { calls.push("two"); } },
    ];
    const app = await createConnectorsApp(testDependencies(modules));
    await app.close();
    expect(calls).toEqual(["one", "two"]);
  });

  it("rejects duplicate module names before registering any module", async () => {
    const register = vi.fn();
    const modules: ConnectorModule[] = [
      { ...testModule("duplicate"), register },
      { ...testModule("duplicate"), register },
    ];
    await expect(createConnectorsApp(testDependencies(modules))).rejects.toThrow(/unique/u);
    expect(register).not.toHaveBeenCalled();
  });

  it("closes earlier module resources when a later module fails registration", async () => {
    const cleanup = vi.fn();
    const failing: ConnectorModule = {
      ...testModule("failing"),
      register: async (app) => {
        app.addHook("onClose", async () => { cleanup(); });
        throw new Error("registration failed");
      },
    };
    await expect(createConnectorsApp(testDependencies([failing]))).rejects.toThrow("registration failed");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("publishes frozen provider extension points with unique names", () => {
    expect(new Set(providerConfigNamespaces.map((namespace) => namespace.name)).size).toBe(providerConfigNamespaces.length);
    expect(new Set(providerModules.map((factory) => factory.name)).size).toBe(providerModules.length);
    expect(Object.isFrozen(providerConfigNamespaces)).toBe(true);
    expect(Object.isFrozen(providerModules)).toBe(true);
  });
});
