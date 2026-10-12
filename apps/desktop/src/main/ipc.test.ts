import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { desktopChannels, type DesktopBridge, type DesktopState } from "../shared/contracts.js";
import { registerDesktopIpc } from "./ipc.js";

const state: DesktopState = {
  settings: { serverOrigin: null, launchAtLogin: false },
  connection: { kind: "unconfigured" },
  launchAtLogin: { requested: false, enabled: false, supported: true },
};
const trusted = { sender: { id: 1 } } as IpcMainInvokeEvent;
const remote = { sender: { id: 2 } } as IpcMainInvokeEvent;
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
let handlers: Map<string, Handler>;
let bridge: DesktopBridge;
let isTrustedSender: ReturnType<typeof vi.fn<(event: IpcMainInvokeEvent) => boolean>>;
let ipcMain: Pick<IpcMain, "handle" | "removeHandler">;

beforeEach(() => {
  handlers = new Map();
  bridge = {
    readState: vi.fn(async () => state),
    validateServer: vi.fn(async (origin: string) => ({ kind: "connected" as const, origin })),
    saveServer: vi.fn(async (origin: string) => ({ kind: "connected" as const, origin })),
    retry: vi.fn(async () => ({ kind: "unconfigured" as const })),
    setLaunchAtLogin: vi.fn(async (enabled) => ({ requested: enabled, enabled, supported: true })),
  };
  isTrustedSender = vi.fn((event) => event === trusted);
  ipcMain = {
    handle: (channel, handler) => { handlers.set(channel, handler); },
    removeHandler: (channel) => { handlers.delete(channel); },
  };
  registerDesktopIpc({ ipcMain, bridge, isTrustedSender });
});

function invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error("Missing IPC handler");
  return Promise.resolve().then(() => handler(event, ...args));
}

describe("desktop IPC boundary", () => {
  it.each(Object.values(desktopChannels))("rejects a remote sender before inspecting payloads or calling services: %s", async (channel) => {
    const inspect = vi.fn(() => { throw new Error("Payload was inspected"); });
    const payload = new Proxy({}, { ownKeys: inspect, get: inspect, getPrototypeOf: inspect });
    await expect(invoke(channel, remote, payload)).rejects.toThrow("Untrusted desktop sender");
    expect(inspect).not.toHaveBeenCalled();
    expect(isTrustedSender).toHaveBeenCalledExactlyOnceWith(remote);
    for (const method of Object.values(bridge)) expect(method).not.toHaveBeenCalled();
  });

  it("reads state and retries only through the authorized callbacks", async () => {
    expect(await invoke(desktopChannels.readState, trusted)).toEqual(state);
    expect(await invoke(desktopChannels.retry, trusted)).toEqual({ kind: "unconfigured" });
    expect(bridge.readState).toHaveBeenCalledExactlyOnceWith();
    expect(bridge.retry).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([desktopChannels.validateServer, desktopChannels.saveServer])("normalizes a valid server before calling %s", async (channel) => {
    expect(await invoke(channel, trusted, { serverUrl: "https://HUB.example.test:443/" })).toEqual({
      kind: "connected", origin: "https://hub.example.test",
    });
    const callback = channel === desktopChannels.saveServer ? bridge.saveServer : bridge.validateServer;
    expect(callback).toHaveBeenCalledExactlyOnceWith("https://hub.example.test");
  });

  it.each([undefined, null, "https://hub.example.test", [], {}, { serverUrl: 9 }, { serverUrl: "https://hub.example.test", token: "fixture" }, { enabled: true }])("rejects malformed server payload %j without any callback", async (payload) => {
    for (const channel of [desktopChannels.validateServer, desktopChannels.saveServer]) {
      await expect(invoke(channel, trusted, payload)).rejects.toThrow("Invalid desktop payload");
    }
    for (const callback of Object.values(bridge)) expect(callback).not.toHaveBeenCalled();
  });

  it.each(["http://hub.example.test", "http://localhost:3000", "https://hub.example.test/private", "https://user:fixture@hub.example.test", "https://hub.example.test?", "https://hub.example.test#", "not a URL"])("rejects unsafe server input %s without calling a service", async (serverUrl) => {
    for (const channel of [desktopChannels.validateServer, desktopChannels.saveServer]) {
      await expect(invoke(channel, trusted, { serverUrl })).rejects.toThrow("Use an HTTPS server origin without credentials, a path, query, or fragment");
    }
    expect(bridge.validateServer).not.toHaveBeenCalled();
    expect(bridge.saveServer).not.toHaveBeenCalled();
  });

  it("permits HTTP loopback only under explicit development configuration", async () => {
    registerDesktopIpc({ ipcMain, bridge, isTrustedSender, allowInsecureLoopback: true });
    expect(await invoke(desktopChannels.validateServer, trusted, { serverUrl: "http://localhost:3000/" })).toEqual({ kind: "connected", origin: "http://localhost:3000" });
    await expect(invoke(desktopChannels.saveServer, trusted, { serverUrl: "http://remote.example.test" })).rejects.toThrow();
  });

  it.each([true, false])("passes only a boolean launch preference (%s)", async (enabled) => {
    expect(await invoke(desktopChannels.setLaunchAtLogin, trusted, { enabled })).toEqual({ requested: enabled, enabled, supported: true });
    expect(bridge.setLaunchAtLogin).toHaveBeenCalledExactlyOnceWith(enabled);
  });

  it.each([undefined, null, true, [], {}, { enabled: "true" }, { enabled: true, serverUrl: "https://hub.example.test" }])("rejects malformed launch preference %j", async (payload) => {
    await expect(invoke(desktopChannels.setLaunchAtLogin, trusted, payload)).rejects.toThrow("Invalid desktop payload");
    expect(bridge.setLaunchAtLogin).not.toHaveBeenCalled();
  });

  it.each(Object.values(desktopChannels))("rejects extra arguments on %s", async (channel) => {
    const args = channel === desktopChannels.setLaunchAtLogin ? [{ enabled: true }] :
      channel === desktopChannels.saveServer || channel === desktopChannels.validateServer ? [{ serverUrl: "https://hub.example.test" }] : [];
    await expect(invoke(channel, trusted, ...args, "unexpected")).rejects.toThrow("Invalid desktop payload");
    for (const callback of Object.values(bridge)) expect(callback).not.toHaveBeenCalled();
  });

  it("removes every registered handler during disposal", () => {
    const dispose = registerDesktopIpc({ ipcMain, bridge, isTrustedSender });
    expect(handlers.size).toBe(5);
    dispose();
    expect(handlers.size).toBe(0);
  });
});
