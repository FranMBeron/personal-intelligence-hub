import { EventEmitter } from "node:events";
import type { BrowserWindowConstructorOptions, Session, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  rejectLoads: false,
  workArea: { x: 0, y: 0, width: 1440, height: 875 },
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
  screen: {
    getPrimaryDisplay: () => ({ workArea: { ...captured.workArea }, workAreaSize: { width: captured.workArea.width, height: captured.workArea.height } }),
  },
}));
import { dialog, shell } from "electron";
import { createControlWindow, createRemoteWindow } from "./windows.js";

const posture = {
  nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
  allowRunningInsecureContent: false, experimentalFeatures: false,
};
type OpenHandler = Parameters<WebContents["setWindowOpenHandler"]>[0];
function openHandler(index = 0): OpenHandler {
  const handler = vi.mocked(captured.windows[index]!.webContents.setWindowOpenHandler).mock.calls[0]?.[0];
  if (!handler) throw new Error("window open handler was not installed");
  return handler;
}
const oauthUrl = "https://accounts.example.test/o/oauth2/auth?client_id=fixture&state=opaque&redirect_uri=https%3A%2F%2Fhub.example.test%2Fcallback";
function requestOauth(index = 0) {
  return openHandler(index)({
    url: oauthUrl, disposition: "foreground-tab", frameName: "_blank", features: "",
    referrer: { url: "https://hub.example.test/calendar", policy: "strict-origin-when-cross-origin" },
  });
}
async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
beforeEach(() => {
  captured.rejectLoads = false;
  captured.workArea = { x: 0, y: 0, width: 1440, height: 875 };
  vi.mocked(dialog.showMessageBox).mockReset();
  vi.mocked(shell.openExternal).mockReset();
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
  it("opens at an explicit hub size with supported minimums and unchanged isolation", () => {
    createRemoteWindow({ allowedOrigin: new URL("https://hub.example.test"), confirmExternal: vi.fn() });
    expect(captured.options[0]).toMatchObject({
      width: 1024, height: 768, minWidth: 480, minHeight: 640,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "persist:pih-remote" },
    });
  });
  it.each([
    [{ x: 0, y: 25, width: 900, height: 600 }, { width: 900, height: 600, minWidth: 480, minHeight: 600 }],
    [{ x: 0, y: 25, width: 420, height: 560 }, { width: 420, height: 560, minWidth: 420, minHeight: 560 }],
    [{ x: 0, y: 25, width: 1000, height: 700 }, { width: 1000, height: 700, minWidth: 480, minHeight: 640 }],
  ])("clamps initial size and minimums to a small work area %o", (workArea, expected) => {
    captured.workArea = workArea;
    createRemoteWindow({ allowedOrigin: new URL("https://hub.example.test"), confirmExternal: vi.fn() });
    const options = captured.options[0]!;
    expect(options).toMatchObject(expected);
    expect(options.width).toBeLessThanOrEqual(workArea.width);
    expect(options.height).toBeLessThanOrEqual(workArea.height);
    expect(options.minWidth).toBeLessThanOrEqual(options.width!);
    expect(options.minHeight).toBeLessThanOrEqual(options.height!);
    expect(options.webPreferences).toMatchObject({ ...posture, partition: "persist:pih-remote" });
  });
  it("hands OAuth to the system browser only after the default human approval", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    const window = createRemoteWindow({ allowedOrigin: new URL("https://hub.example.test") });
    expect(requestOauth()).toEqual({ action: "deny" });
    expect(shell.openExternal).not.toHaveBeenCalled();
    await settle();
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith(oauthUrl);
    expect(vi.mocked(dialog.showMessageBox).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(shell.openExternal).mock.invocationCallOrder[0]!);
    expect(captured.windows).toHaveLength(1);
    expect(window.loadURL).toHaveBeenCalledExactlyOnceWith("https://hub.example.test/");
  });
  it("leaves the hub window intact and opens nothing when OAuth handoff is denied", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    const window = createRemoteWindow({ allowedOrigin: new URL("https://hub.example.test") });
    expect(requestOauth()).toEqual({ action: "deny" });
    await settle();
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(captured.windows).toHaveLength(1);
    expect(window.loadURL).toHaveBeenCalledExactlyOnceWith("https://hub.example.test/");
    expect(window.webContents.listenerCount("will-navigate")).toBe(1);
    expect(window.listenerCount("closed")).toBe(1);
  });
  it("never loads the OAuth provider inside the hub window", () => {
    const confirm = vi.fn();
    const window = createRemoteWindow({ allowedOrigin: new URL("https://hub.example.test"), confirmExternal: confirm });
    const event = { url: oauthUrl, preventDefault: vi.fn() };
    window.webContents.emit("will-navigate", event, oauthUrl);
    window.webContents.emit("will-redirect", event, oauthUrl);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
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
  it("keeps the local control size on a work area that fits it", () => {
    captured.workArea = { x: 0, y: 25, width: 1000, height: 700 };
    createControlWindow({ preloadPath: "/packaged/preload.cjs" });
    expect(captured.options[0]).toMatchObject({ width: 720, height: 700, minWidth: 480, minHeight: 640 });
  });
  it("never opens the local control window larger than a tiny work area", () => {
    captured.workArea = { x: 0, y: 25, width: 420, height: 560 };
    createControlWindow({ preloadPath: "/packaged/preload.cjs" });
    expect(captured.options[0]).toMatchObject({ width: 420, height: 560, minWidth: 420, minHeight: 560 });
  });
  it("uses only the supplied packaged preload with the same sandbox posture", () => {
    createControlWindow({ preloadPath: "/packaged/preload.cjs" });
    expect(captured.options[0]?.webPreferences).toMatchObject(posture);
    expect(captured.options[0]?.webPreferences?.preload).toBe("/packaged/preload.cjs");
    expect(captured.options[0]?.webPreferences?.partition).not.toBe("persist:pih-remote");
    expect(captured.windows[0]?.loadURL).not.toHaveBeenCalled();
  });
});
