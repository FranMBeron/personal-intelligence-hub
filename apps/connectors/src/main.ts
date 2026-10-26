import {
  chmod as chmodFile,
  chown as chownFile,
  lstat as lstatFile,
  mkdir as mkdirDirectory,
  unlink as unlinkFile,
} from "node:fs/promises";
import { posix } from "node:path";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

import {
  loadConnectorsConfig,
  type ConnectorsConfig,
} from "./config/private.js";
import type { ProviderConfigNamespace } from "./config/provider-namespace.js";
import { openConnectorDatabase, type ConnectorDatabase } from "./foundation/database.js";
import type { ConnectorModule, ConnectorModuleDependencies, ProviderModuleFactory } from "./foundation/module.js";
import { createConnectorsApp } from "./app.js";
import { providerConfigNamespaces, providerModules } from "./providers.js";

type SocketPathInfo = Readonly<{
  uid: number;
  gid: number;
  mode: number;
  dev: number;
  ino: number;
  isDirectory(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
}>;

export type SocketFileSystem = Readonly<{
  lstat(path: string): Promise<SocketPathInfo>;
  mkdir(path: string, options: { mode: number }): Promise<unknown>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
}>;

type SocketConnection = Readonly<{
  once(event: "connect" | "error", listener: (error?: NodeJS.ErrnoException) => void): SocketConnection;
  destroy(): void;
}>;

export type SocketNetwork = Readonly<{
  createConnection(options: { path: string }): SocketConnection;
}>;

const defaultFileSystem: SocketFileSystem = {
  lstat: (path) => lstatFile(path),
  mkdir: (path, options) => mkdirDirectory(path, options),
  chown: (path, uid, gid) => chownFile(path, uid, gid),
  chmod: (path, mode) => chmodFile(path, mode),
  unlink: (path) => unlinkFile(path),
};

const defaultNetwork: SocketNetwork = { createConnection };

const errno = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const missingPath = async (fs: SocketFileSystem, path: string): Promise<boolean> => {
  try {
    await fs.lstat(path);
    return false;
  } catch (error) {
    if (errno(error) === "ENOENT") return true;
    throw error;
  }
};

const sameInode = (left: SocketPathInfo, right: SocketPathInfo): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const assertRealDirectory = (
  entry: SocketPathInfo,
  uid: number,
  label: string,
): void => {
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    entry.uid !== uid ||
    (entry.mode & 0o022) !== 0
  ) {
    throw new Error(label + " must be a protected service-owned directory");
  }
};

const canConnectToSocket = (
  network: SocketNetwork,
  path: string,
): Promise<boolean> => new Promise((resolve, reject) => {
  let settled = false;
  let socket: SocketConnection;
  try {
    socket = network.createConnection({ path });
  } catch (error) {
    reject(error);
    return;
  }
  socket.once("connect", () => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(true);
  });
  socket.once("error", (error) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    if (errno(error) === "ECONNREFUSED") resolve(false);
    else reject(error);
  });
});

export const prepareSocketPath = async (
  path: string,
  serviceUid: number,
  clientGid: number,
  dependencies: Readonly<{ fs?: SocketFileSystem; net?: SocketNetwork; production?: boolean }> = {},
): Promise<void> => {
  const fs = dependencies.fs ?? defaultFileSystem;
  const net = dependencies.net ?? defaultNetwork;
  const production = dependencies.production ?? true;
  const parent = posix.dirname(path);
  const productionParent = "/run/pih-connectors/web";
  const serviceDirectory = "/run/pih-connectors";
  if (
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    posix.basename(path).length === 0 ||
    path === "/run/pih-connectors/hermes-delegation.sock" ||
    path.startsWith("/run/pih-connectors/agents/") ||
    (production && parent !== productionParent)
  ) {
    throw new Error("Connector socket must be inside the BFF socket directory");
  }

  if (production) {
    const baseEntry = await fs.lstat(serviceDirectory);
    assertRealDirectory(baseEntry, serviceUid, "Connector service root");
    if (await missingPath(fs, parent)) {
      await fs.mkdir(parent, { mode: 0o750 });
    }
  } else if (await missingPath(fs, parent)) {
    throw new Error("Non-production connector socket directory must already exist");
  }
  let directory = await fs.lstat(parent);
  assertRealDirectory(directory, serviceUid, "Connector socket directory");
  await fs.chown(parent, serviceUid, clientGid);
  await fs.chmod(parent, 0o750);
  directory = await fs.lstat(parent);
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    directory.uid !== serviceUid ||
    directory.gid !== clientGid ||
    (directory.mode & 0o777) !== 0o750
  ) {
    throw new Error("Connector socket directory permissions are invalid");
  }

  if (await missingPath(fs, path)) return;
  const existing = await fs.lstat(path);
  if (
    existing.isSymbolicLink() ||
    !existing.isSocket() ||
    existing.uid !== serviceUid
  ) {
    throw new Error("Existing connector socket path is unsafe");
  }
  if (await canConnectToSocket(net, path)) {
    throw new Error("Connector socket is already active");
  }

  const beforeUnlink = await fs.lstat(path);
  if (
    !sameInode(existing, beforeUnlink) ||
    beforeUnlink.isSymbolicLink() ||
    !beforeUnlink.isSocket() ||
    beforeUnlink.uid !== serviceUid
  ) {
    throw new Error("Connector socket changed during stale-path validation");
  }
  await fs.unlink(path);
};

const secureListeningSocket = async (
  path: string,
  identity: SocketPathInfo,
  serviceUid: number,
  clientGid: number,
  fs: SocketFileSystem,
): Promise<void> => {
  const beforeChange = await fs.lstat(path);
  if (
    !sameInode(identity, beforeChange) ||
    beforeChange.isSymbolicLink() ||
    !beforeChange.isSocket() ||
    beforeChange.uid !== serviceUid
  ) {
    throw new Error("Listening connector socket has unsafe ownership");
  }
  await fs.chown(path, serviceUid, clientGid);
  const beforeMode = await fs.lstat(path);
  if (!sameInode(identity, beforeMode) || beforeMode.isSymbolicLink() || !beforeMode.isSocket()) {
    throw new Error("Listening connector socket changed during ownership setup");
  }
  await fs.chmod(path, 0o660);
  const after = await fs.lstat(path);
  if (
    !sameInode(identity, after) ||
    after.isSymbolicLink() ||
    !after.isSocket() ||
    after.uid !== serviceUid ||
    after.gid !== clientGid ||
    (after.mode & 0o777) !== 0o660
  ) {
    throw new Error("Listening connector socket permissions are invalid");
  }
};

const removeCreatedSocket = async (
  path: string,
  identity: SocketPathInfo | undefined,
  fs: SocketFileSystem,
): Promise<void> => {
  if (identity === undefined || await missingPath(fs, path)) return;
  const current = await fs.lstat(path);
  if (
    sameInode(identity, current) &&
    current.isSocket() &&
    !current.isSymbolicLink() &&
    current.uid === identity.uid
  ) {
    await fs.unlink(path);
  }
};

export type ConnectorsProcess = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  getuid?(): number;
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off?(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  stderr?: Readonly<{ write(value: string): unknown }>;
}>;

export type StartConnectorsDependencies = Readonly<{
  process?: ConnectorsProcess;
  fs?: SocketFileSystem;
  net?: SocketNetwork;
  environment?: Readonly<Record<string, string | undefined>>;
  configNamespaces?: readonly ProviderConfigNamespace<string, unknown>[];
  providerModules?: readonly ProviderModuleFactory[];
  loadConfig?: (
    environment: Readonly<Record<string, string | undefined>>,
    namespaces: readonly ProviderConfigNamespace<string, unknown>[],
  ) => ConnectorsConfig;
  openDatabase?: (path: string) => ConnectorDatabase;
  createApp?: typeof createConnectorsApp;
  requestIdFactory?: () => string;
}>;

export type RunningConnectors = Readonly<{
  app: FastifyInstance;
  database: ConnectorDatabase;
  shutdown(): Promise<void>;
}>;

const assertUniqueFactoryNames = (factories: readonly ProviderModuleFactory[]): void => {
  const names = new Set<string>();
  for (const factory of factories) {
    if (names.has(factory.name)) throw new Error("Provider factory names must be unique");
    names.add(factory.name);
  }
};

export const startConnectors = async (
  dependencies: StartConnectorsDependencies = {},
): Promise<RunningConnectors> => {
  const processRef = dependencies.process ?? process;
  const environment = dependencies.environment ?? processRef.env;
  const namespaces = dependencies.configNamespaces ?? providerConfigNamespaces;
  const factories = dependencies.providerModules ?? providerModules;
  assertUniqueFactoryNames(factories);
  const config = (dependencies.loadConfig ?? loadConnectorsConfig)(environment, namespaces);
  const database = (dependencies.openDatabase ?? openConnectorDatabase)(config.databasePath);
  let app: FastifyInstance | undefined;
  let socketIdentity: SocketPathInfo | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async () => {
      let socketPathChanged = false;
      if (config.transport.kind === "unix" && socketIdentity !== undefined) {
        try {
          const current = await (dependencies.fs ?? defaultFileSystem).lstat(config.transport.path);
          socketPathChanged =
            !sameInode(socketIdentity, current) ||
            current.isSymbolicLink() ||
            !current.isSocket() ||
            current.uid !== socketIdentity.uid;
        } catch {
          socketPathChanged = true;
        }
      }
      if (socketPathChanged) {
        processRef.stderr?.write("Connector socket path changed before shutdown; verify the BFF socket directory ownership\n");
      }
      processRef.off?.("SIGINT", onInterrupt);
      processRef.off?.("SIGTERM", onInterrupt);
      let firstError: unknown;
      if (app !== undefined) {
        try {
          // Node unlinks Unix server paths by pathname during close. The service-owned
          // 0750 directory prevents untrusted users from replacing that entry.
          await app.close();
        } catch (error) {
          firstError = error;
        }
      }
      try {
        await database.close();
      } catch (error) {
        firstError ??= error;
      }
      if (config.transport.kind === "unix") {
        try {
          await removeCreatedSocket(config.transport.path, socketIdentity, dependencies.fs ?? defaultFileSystem);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    })();
    return shutdownPromise;
  };

  const onInterrupt = () => {
    void shutdown().catch(() => {
      processRef.stderr?.write("Connector service shutdown failed safely\n");
    });
  };

  try {
    const serviceUid = processRef.getuid?.();
    if (serviceUid === undefined) throw new Error("Connector service requires a Unix process UID");
    const moduleDependencies: ConnectorModuleDependencies = Object.freeze({
      config,
      database,
      clock: Object.freeze({ now: () => new Date() }),
      idGenerator: Object.freeze({ generate: dependencies.requestIdFactory ?? randomUUID }),
    });
    const modules: ConnectorModule[] = factories.map((factory) => factory.create(moduleDependencies));
    app = await (dependencies.createApp ?? createConnectorsApp)({
      ...moduleDependencies,
      modules: Object.freeze(modules),
      ...(dependencies.requestIdFactory === undefined ? {} : { requestIdFactory: dependencies.requestIdFactory }),
    });

    if (config.transport.kind === "unix") {
      await prepareSocketPath(config.transport.path, serviceUid, config.transport.socketGid, {
        ...(dependencies.fs === undefined ? {} : { fs: dependencies.fs }),
        ...(dependencies.net === undefined ? {} : { net: dependencies.net }),
        production: environment.NODE_ENV === "production",
      });
      await app.listen({ path: config.transport.path });
      socketIdentity = await (dependencies.fs ?? defaultFileSystem).lstat(config.transport.path);
      if (
        socketIdentity.isSymbolicLink() ||
        !socketIdentity.isSocket() ||
        socketIdentity.uid !== serviceUid
      ) {
        throw new Error("Listening connector socket has unsafe ownership");
      }
      await secureListeningSocket(
        config.transport.path,
        socketIdentity,
        serviceUid,
        config.transport.socketGid,
        dependencies.fs ?? defaultFileSystem,
      );
    } else {
      await app.listen({ host: config.transport.host, port: config.transport.port });
    }

    processRef.on("SIGINT", onInterrupt);
    processRef.on("SIGTERM", onInterrupt);
    return Object.freeze({ app, database, shutdown });
  } catch (error) {
    if (app !== undefined) await app.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    if (config.transport.kind === "unix") {
      await removeCreatedSocket(config.transport.path, socketIdentity, dependencies.fs ?? defaultFileSystem).catch(() => undefined);
    }
    throw error;
  }
};

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) {
  void startConnectors().catch(() => {
    process.stderr.write("Connector service failed to start safely\n");
    process.exitCode = 1;
  });
}
