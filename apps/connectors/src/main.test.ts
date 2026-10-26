import { EventEmitter } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ConnectorsConfig } from "./config/private.js";
import type { ConnectorDatabase } from "./foundation/database.js";
import type { ProviderModuleFactory } from "./foundation/module.js";
import {
  prepareSocketPath,
  startConnectors,
  type SocketFileSystem,
  type SocketNetwork,
} from "./main.js";

const SOCKET = "/run/pih-connectors/web/connectors.sock";
const mode = (value: number) => value;

const fakeStat = (kind: "directory" | "socket" | "symlink", values: Partial<{ uid: number; gid: number; mode: number; dev: number; ino: number }> = {}) => ({
  uid: values.uid ?? 1001,
  gid: values.gid ?? 1002,
  mode: mode(values.mode ?? (kind === "directory" ? 0o40750 : kind === "socket" ? 0o140660 : 0o120777)),
  dev: values.dev ?? 7,
  ino: values.ino ?? 11,
  isDirectory: () => kind === "directory",
  isSocket: () => kind === "socket",
  isSymbolicLink: () => kind === "symlink",
});

const refusedNetwork: SocketNetwork = {
  createConnection: () => {
    const socket = new EventEmitter() as EventEmitter & { destroy(): void };
    socket.destroy = () => undefined;
    queueMicrotask(() => socket.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
    return socket as never;
  },
};

const baseConfig: ConnectorsConfig = {
  transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
  databasePath: "/tmp/connectors-main-test.sqlite",
  serviceCredentials: [], audience: "personal-intelligence-hub-connectors",
  defaultTimeZone: "Etc/UTC", logLevel: "error",
};

describe("connector Unix socket preparation", () => {
  it("refuses paths outside the BFF socket directory before inspecting them", async () => {
    const lstat = vi.fn();
    const fs = { lstat } as unknown as SocketFileSystem;
    await expect(prepareSocketPath("/run/pih-connectors/hermes-delegation.sock", 1001, 1002, { fs })).rejects.toThrow(/BFF socket directory/u);
    // Not even outside production may the BFF socket share the agent-only directory.
    await expect(prepareSocketPath("/run/pih-connectors/agents/connectors.sock", 1001, 1002, { fs, production: false })).rejects.toThrow(/BFF socket directory/u);
    expect(lstat).not.toHaveBeenCalled();
  });

  it("creates only the service child directory and removes a verified stale BFF socket", async () => {
    const directory = fakeStat("directory");
    const socket = fakeStat("socket");
    let hasWeb = false;
    let hasSocket = true;
    const unlinked: string[] = [];
    const fs: SocketFileSystem = {
      async lstat(path) {
        if (path === "/run/pih-connectors") return fakeStat("directory");
        if (path === "/run/pih-connectors/web") {
          if (!hasWeb) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return directory;
        }
        if (path === SOCKET) {
          if (!hasSocket) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return socket;
        }
        throw new Error("unexpected path");
      },
      async mkdir(path, options) { expect(path).toBe("/run/pih-connectors/web"); expect(options.mode).toBe(0o750); hasWeb = true; },
      async chown(path, uid, gid) { expect(path).toBe("/run/pih-connectors/web"); directory.uid = uid; directory.gid = gid; },
      async chmod(path, value) { expect(path).toBe("/run/pih-connectors/web"); directory.mode = value; },
      async unlink(path) { unlinked.push(path); hasSocket = false; },
    };
    await prepareSocketPath(SOCKET, 1001, 1002, { fs, net: refusedNetwork });
    expect(unlinked).toEqual([SOCKET]);
  });

  it("refuses symlink, foreign-owned, or non-socket occupants without connecting", async () => {
    const occupants = [
      fakeStat("symlink"),
      fakeStat("socket", { uid: 2002 }),
      fakeStat("directory"),
    ];
    for (const occupant of occupants) {
      const directory = fakeStat("directory");
      const connect = vi.fn();
      const fs: SocketFileSystem = {
        async lstat(path) {
          if (path === "/run/pih-connectors") return fakeStat("directory");
          if (path === "/run/pih-connectors/web") return directory;
          if (path === SOCKET) return occupant;
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        async mkdir() {},
        async chown(path, uid, gid) { if (path.endsWith("/web")) { directory.uid = uid; directory.gid = gid; } },
        async chmod(path, value) { if (path.endsWith("/web")) directory.mode = value; },
        async unlink() {},
      };
      await expect(prepareSocketPath(SOCKET, 1001, 1002, {
        fs,
        net: { createConnection: connect } as unknown as SocketNetwork,
      })).rejects.toThrow(/unsafe/u);
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it("refuses active sockets without unlinking them", async () => {
    const root = fakeStat("directory");
    const directory = fakeStat("directory");
    const socketInfo = fakeStat("socket");
    const unlink = vi.fn();
    const fs: SocketFileSystem = {
      async lstat(path) {
        if (path === "/run/pih-connectors") return root;
        if (path === "/run/pih-connectors/web") return directory;
        if (path === SOCKET) return socketInfo;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      async mkdir() {}, async chown(path, uid, gid) { if (path.endsWith("/web")) { directory.uid = uid; directory.gid = gid; } },
      async chmod(path, value) { if (path.endsWith("/web")) directory.mode = value; },
      unlink,
    };
    const active: SocketNetwork = { createConnection: () => {
      const socket = new EventEmitter() as EventEmitter & { destroy(): void };
      socket.destroy = () => undefined;
      queueMicrotask(() => socket.emit("connect"));
      return socket as never;
    } };
    await expect(prepareSocketPath(SOCKET, 1001, 1002, { fs, net: active })).rejects.toThrow(/already active/u);
    expect(unlink).not.toHaveBeenCalled();
  });

  it("detects a stale socket inode replacement immediately before unlink", async () => {
    const directory = fakeStat("directory");
    const original = fakeStat("socket", { ino: 11 });
    const replacement = fakeStat("socket", { ino: 12 });
    let socketChecks = 0;
    const unlink = vi.fn();
    const fs: SocketFileSystem = {
      async lstat(path) {
        if (path === "/run/pih-connectors") return fakeStat("directory");
        if (path === "/run/pih-connectors/web") return directory;
        if (path === SOCKET) return ++socketChecks >= 3 ? replacement : original;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      async mkdir() {}, async chown(path, uid, gid) { if (path.endsWith("/web")) { directory.uid = uid; directory.gid = gid; } },
      async chmod(path, value) { if (path.endsWith("/web")) directory.mode = value; },
      unlink,
    };
    await expect(prepareSocketPath(SOCKET, 1001, 1002, { fs, net: refusedNetwork })).rejects.toThrow(/changed during stale/u);
    expect(unlink).not.toHaveBeenCalled();
  });
});

describe("connector process lifecycle", () => {
  it("creates each provider once after config and database, then drains app before closing database", async () => {
    const order: string[] = [];
    const db = { close: async () => { order.push("database.close"); } } as unknown as ConnectorDatabase;
    const factoryCreate = vi.fn((dependencies) => {
      expect(dependencies.config).toBe(baseConfig);
      expect(dependencies.database).toBe(db);
      order.push("factory.create");
      return { name: "sample", register: async () => undefined, status: async () => ({ id: "sample", state: "available" as const, checkedAt: new Date().toISOString(), stale: false, capabilities: [] }) };
    });
    const factory: ProviderModuleFactory = { name: "sample", create: factoryCreate };
    const handlers: Record<string, () => void> = {};
    const processRef = {
      env: {},
      getuid: () => 1001,
      on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => { handlers[signal] = listener; },
      off: (signal: "SIGINT" | "SIGTERM") => { delete handlers[signal]; },
    };
    const result = await startConnectors({
      process: processRef,
      environment: {},
      loadConfig: () => baseConfig,
      openDatabase: () => db,
      providerModules: [factory],
      createApp: async () => ({
        async listen() { order.push("app.listen"); },
        async close() { order.push("app.close"); },
      } as never),
    });
    expect(factoryCreate).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["factory.create", "app.listen"]);
    handlers.SIGTERM?.();
    await result.shutdown();
    expect(order).toEqual(["factory.create", "app.listen", "app.close", "database.close"]);
  });

  it("closes DB and reports an error even when Fastify close fails", async () => {
    const dbClose = vi.fn(async () => undefined);
    const db = { close: dbClose } as unknown as ConnectorDatabase;
    const appClose = vi.fn(async () => { throw new Error("close failed"); });
    const running = await startConnectors({
      process: { env: {}, getuid: () => 1001, on: () => undefined, off: () => undefined },
      environment: {}, loadConfig: () => baseConfig, openDatabase: () => db,
      providerModules: [],
      createApp: async () => ({ async listen() {}, close: appClose } as never),
    });
    await expect(running.shutdown()).rejects.toThrow("close failed");
    expect(appClose).toHaveBeenCalledTimes(1);
    expect(dbClose).toHaveBeenCalledTimes(1);
  });

  it("closes the listener and removes only the socket inode it started", async () => {
    const unixConfig: ConnectorsConfig = {
      ...baseConfig,
      transport: { kind: "unix", path: SOCKET, socketGid: 1002 },
    };
    const directory = fakeStat("directory");
    let webExists = false;
    let socketInfo: ReturnType<typeof fakeStat> | undefined;
    const order: string[] = [];
    const fs: SocketFileSystem = {
      async lstat(path) {
        if (path === "/run/pih-connectors") return fakeStat("directory");
        if (path === "/run/pih-connectors/web") {
          if (!webExists) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return directory;
        }
        if (path === SOCKET) {
          if (socketInfo === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return socketInfo;
        }
        throw new Error("unexpected path");
      },
      async mkdir() { webExists = true; },
      async chown(path, uid, gid) {
        if (path.endsWith("/web")) { directory.uid = uid; directory.gid = gid; }
        else if (socketInfo !== undefined) { socketInfo.uid = uid; socketInfo.gid = gid; }
      },
      async chmod(path, value) {
        if (path.endsWith("/web")) directory.mode = value;
        else if (socketInfo !== undefined) socketInfo.mode = value;
      },
      async unlink(path) { order.push("unlink"); expect(path).toBe(SOCKET); socketInfo = undefined; },
    };
    const db = { close: async () => { order.push("database.close"); } } as unknown as ConnectorDatabase;
    const running = await startConnectors({
      process: { env: {}, getuid: () => 1001, on: () => undefined, off: () => undefined },
      environment: { NODE_ENV: "production" }, loadConfig: () => unixConfig, openDatabase: () => db,
      providerModules: [], fs, net: refusedNetwork,
      createApp: async () => ({
        async listen() { socketInfo = fakeStat("socket", { uid: 1001, mode: 0o140600, ino: 41 }); },
        async close() { order.push("app.close"); },
      } as never),
    });

    await running.shutdown();

    expect(order).toEqual(["app.close", "database.close", "unlink"]);
    expect(socketInfo).toBeUndefined();
  });

  it("restarts a real Unix listener in an isolated temporary directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pih-connectors-socket-"));
    const socketPath = join(directory, "connectors.sock");
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) throw new Error("Test requires a Unix UID and GID");
    const unixConfig: ConnectorsConfig = {
      ...baseConfig,
      transport: { kind: "unix", path: socketPath, socketGid: gid },
    };
    const database = { close: async () => undefined } as unknown as ConnectorDatabase;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const running = await startConnectors({
          environment: { NODE_ENV: "test" },
          loadConfig: () => unixConfig,
          openDatabase: () => database,
          providerModules: [],
        });
        await expect(lstat(socketPath)).resolves.toMatchObject({ uid });
        await running.shutdown();
        await expect((await import("node:fs/promises")).lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a service root writable by group or other users", async () => {
    const lstat = vi.fn(async () => fakeStat("directory", { mode: 0o40770 }));
    const fs = { lstat } as unknown as SocketFileSystem;
    await expect(prepareSocketPath(SOCKET, 1001, 1002, { fs })).rejects.toThrow(/protected service-owned directory/u);
    expect(lstat).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate provider factory names before opening the database", async () => {
    const openDatabase = vi.fn();
    const factory: ProviderModuleFactory = { name: "repeat", create: () => { throw new Error("must not create"); } };
    await expect(startConnectors({
      process: { env: {}, getuid: () => 1001, on: () => undefined },
      environment: {}, loadConfig: () => baseConfig, openDatabase,
      providerModules: [factory, factory],
    })).rejects.toThrow(/unique/u);
    expect(openDatabase).not.toHaveBeenCalled();
  });
});
