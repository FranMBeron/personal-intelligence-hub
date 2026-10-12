import { expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(async () => ({ fixture: true })) }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: captured.expose },
  ipcRenderer: { invoke: captured.invoke },
}));
import type { DesktopBridge } from "./shared/contracts.js";

it("exposes only a frozen bridge and maps each operation to its exact channel and payload", async () => {
  await import("./preload.js");
  expect(captured.expose).toHaveBeenCalledOnce();
  const [name, bridge] = captured.expose.mock.calls[0] as [string, DesktopBridge];
  expect(name).toBe("desktop");
  expect(Object.isFrozen(bridge)).toBe(true);
  expect(Object.keys(bridge).sort()).toEqual(["readState", "retry", "saveServer", "setLaunchAtLogin", "validateServer"]);
  expect(await bridge.readState()).toEqual({ fixture: true });
  expect(captured.invoke).toHaveBeenLastCalledWith("desktop:read-state");
  await bridge.validateServer("https://hub.example.test");
  expect(captured.invoke).toHaveBeenLastCalledWith("desktop:validate-server", { serverUrl: "https://hub.example.test" });
  await bridge.saveServer("https://hub.example.test");
  expect(captured.invoke).toHaveBeenLastCalledWith("desktop:save-server", { serverUrl: "https://hub.example.test" });
  await bridge.retry();
  expect(captured.invoke).toHaveBeenLastCalledWith("desktop:retry");
  await bridge.setLaunchAtLogin(false);
  expect(captured.invoke).toHaveBeenLastCalledWith("desktop:set-launch-at-login", { enabled: false });
});
