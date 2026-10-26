import type { SourceStatus } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";

import type { ConnectorsConfig } from "../config/private.js";
import type { ConnectorDatabase } from "./database.js";

export type ConnectorModuleDependencies = Readonly<{
  config: ConnectorsConfig;
  database: ConnectorDatabase;
  clock: Readonly<{ now(): Date }>;
  idGenerator: Readonly<{ generate(): string }>;
}>;

export interface ConnectorModule {
  readonly name: string;
  register(app: FastifyInstance, dependencies: ConnectorModuleDependencies): Promise<void>;
  status(dependencies: ConnectorModuleDependencies): Promise<SourceStatus>;
}

export type ProviderModuleFactory = Readonly<{
  name: string;
  create(dependencies: ConnectorModuleDependencies): ConnectorModule;
}>;
