import { EventEmitter } from "node:events";
import type { BrowserWindowConstructorOptions, Session, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  rejectLoads: false,
  options: [] as BrowserWindowConstructorOptions[],
  windows: [] as Array<{ emit: EventEmitter["emit"]; webContents: WebContents; loadURL: ReturnType<typeof vi.fn> }>,
}));
vi.mock("electron", () => ({
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      session: Object.assign(new EventEmitter(), {
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
      }) as unknown as Session,
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => false,
    }) as unknown as WebContents;
    loadURL = vi.fn(async (_url: string) => {
      expect(this.webContents.listenerCount("will-navigate")).toBe(1);
      expect(this.webContents.listenerCount("will-redirect")).toBe(1);
      expect(this.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
      expect(this.webContents.session.setPermissionCheckHandler).toHaveBeenCalledOnce();
      expect(this.webContents.session.setPermissionRequestHandler).toHaveBeenCalledOnce();
      if (captured.rejectLoads) throw new Error("fixture");
    });
    constructor(options: BrowserWindowConstructorOptions) {
      super();
      captured.options.push(options);
      captured.windows.push(this);
    }
  },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
import { createControlWindow, createRemoteWindow } from "./windows.js";

const posture = {
  nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
  allowRunningInsecureContent: false, experimentalFeatures: false,
};
beforeEach(() => {
  captured.rejectLoads = false;
  captured.options.length = 0;
  captured.windows.length = 0;
});
describe("createRemoteWindow", () => {
  it("constructs a sandboxed window with no preload and installs policy before loading", () => {
    const window = createRemoteWindow({ allowedOrigin: new URL("https://hub.example.test"), confirmExternal: vi.fn() });
    expect(captured.options[0]?.webPreferences).toMatchObject(posture);
    expect(captured.options[0]?.webPreferences).not.toHaveProperty("preload");
    expect(captured.options[0]?.webPreferences?.partition).toBe("persist:pih-remote");
    expect(window.loadURL).toHaveBeenCalledExactlyOnceWith("https://hub.example.test/");
  });
  it("removes policy handlers when closed, including after reconnect", () => {
    const first = createRemoteWindow({ allowedOrigin: new URL("https://hub.example.test"), confirmExternal: vi.fn() });
    first.emit("closed");
    expect(first.webContents.listenerCount("will-navigate")).toBe(0);
    expect(first.webContents.listenerCount("will-redirect")).toBe(0);
    expect(first.webContents.session.listenerCount("will-download")).toBe(0);
    const next = createRemoteWindow({ allowedOrigin: new URL("https://hub.example.test"), confirmExternal: vi.fn() });
    expect(next.webContents.listenerCount("will-navigate")).toBe(1);
  });
  it("contains load rejection so recovery can rely on Electron load events", async () => {
    captured.rejectLoads = true;
    createRemoteWindow({ allowedOrigin: new URL("https://hub.example.test"), confirmExternal: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));
  });
});
describe("createControlWindow", () => {
  it("opens at a readable size and enforces the renderer's supported minimum viewport", () => {
    createControlWindow({ preloadPath: "/packaged/preload.cjs" });
    expect(captured.options[0]).toMatchObject({ width: 720, height: 700, minWidth: 480, minHeight: 640 });
  });
  it("uses only the supplied packaged preload with the same sandbox posture", () => {
    createControlWindow({ preloadPath: "/packaged/preload.cjs" });
    expect(captured.options[0]?.webPreferences).toMatchObject(posture);
    expect(captured.options[0]?.webPreferences?.preload).toBe("/packaged/preload.cjs");
    expect(captured.options[0]?.webPreferences?.partition).not.toBe("persist:pih-remote");
    expect(captured.windows[0]?.loadURL).not.toHaveBeenCalled();
  });
});
