import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopChannels } from "./shared/contracts.js";

const env = vi.hoisted(() => ({
  directory: "", lock: true, ready: false, login: false, quit: false,
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  menus: [] as MenuItemConstructorOptions[][],
  template: false, imageData: "", errorBoxes: 0, trayDestructions: 0,
}));
class WindowFixture extends EventEmitter {
  visible = false; destroyed = false; url = "";
  preventUnload = false; unloadAttempts = 0;
  loadDelay: Promise<void> | undefined;
  webContents = Object.assign(new EventEmitter(), { mainFrame: { url: "" }, getURL: () => this.url, setWindowOpenHandler: () => undefined });
  show() { this.visible = true; } hide() { this.visible = false; } focus() {} isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  close() {
    let prevented = false;
    this.emit("close", { preventDefault: () => { prevented = true; } });
    if (prevented) return;
    this.unloadAttempts += 1;
    if (!this.preventUnload) this.destroy();
  }
  async loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; await this.loadDelay; }
}
const local: WindowFixture[] = [];
const remote: WindowFixture[] = [];
const trays: EventEmitter[] = [];
const app = Object.assign(new EventEmitter(), {
  setName: () => undefined, setAppUserModelId: () => undefined,
  getPath: () => env.directory, getAppPath: () => "/app", isPackaged: true,
  requestSingleInstanceLock: () => env.lock,
  whenReady: async () => { env.ready = true; },
  quit: () => {
    app.emit("before-quit");
    for (const window of [...local, ...remote]) if (!window.isDestroyed()) window.close();
    env.quit = [...local, ...remote].every((window) => window.isDestroyed());
  },
  getLoginItemSettings: () => ({ openAtLogin: env.login }),
  setLoginItemSettings: ({ openAtLogin }: { openAtLogin: boolean }) => { env.login = openAtLogin; },
});
vi.mock("electron", () => ({
  app,
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { env.handlers.set(channel, handler); }, removeHandler: (channel: string) => { env.handlers.delete(channel); } },
  Menu: { buildFromTemplate: (items: MenuItemConstructorOptions[]) => items },
  Tray: class extends EventEmitter { constructor() { super(); trays.push(this); } setToolTip() {} popUpContextMenu(menu: MenuItemConstructorOptions[]) { env.menus.push(menu); } destroy() { env.trayDestructions += 1; } },
  nativeImage: { createFromPath: () => ({ setTemplateImage: (flag: boolean) => { env.template = flag; } }), createFromDataURL: (data: string) => { env.imageData = data; return { setTemplateImage: (flag: boolean) => { env.template = flag; } }; } },
  dialog: { showErrorBox: () => { env.errorBoxes += 1; } },
}));
vi.mock("./main/windows.js", () => ({
  createRemoteWindow: () => { const w = new WindowFixture(); remote.push(w); return w; },
  createControlWindow: () => { const w = new WindowFixture(); local.push(w); return w; },
}));
vi.mock("./main/connectivity.js", () => ({ checkServer: async (url: URL) => ({ kind: "connected", origin: url.origin }) }));
beforeEach(async () => {
  vi.resetModules(); env.directory = await mkdtemp(join(tmpdir(), "pih-main-")); env.lock = true; env.ready = false; env.login = false; env.quit = false; env.template = false; env.imageData = ""; env.errorBoxes = 0; env.trayDestructions = 0; app.setAppUserModelId = () => undefined;
  env.handlers.clear(); env.menus.length = 0; local.length = 0; remote.length = 0; trays.length = 0; app.removeAllListeners(); app.isPackaged = true;
  vi.stubGlobal("CONTROL_WINDOW_VITE_DEV_SERVER_URL", undefined);
  vi.stubGlobal("CONTROL_WINDOW_VITE_NAME", "control_window");
  vi.stubGlobal("process", { ...process, platform: "darwin" });
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(env.directory, { recursive: true, force: true }); });
it("wires packaged local IPC and refreshes the tray from actual OS state on every opening", async () => {
  await import("./main.js");
  await vi.waitFor(() => { expect(local).toHaveLength(1); expect(trays).toHaveLength(1); });
  expect(local[0]?.url).toMatch(/\/renderer\/index\.html$/);
  expect(local[0]?.url).not.toContain("control_window/");
  expect(env.template).toBe(true);
  expect(env.imageData).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  const w = local[0]!;
  const sender = { sender: w.webContents, senderFrame: w.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  const payload = new Proxy({}, { ownKeys: () => { throw new Error("payload inspected"); } });
  expect(() => env.handlers.get(desktopChannels.saveServer)?.({ sender: {} } as IpcMainInvokeEvent, payload)).toThrow("Untrusted desktop sender");
  await env.handlers.get(desktopChannels.saveServer)?.(sender, { serverUrl: "https://hub.example.test" });
  expect(remote[0]?.visible).toBe(true);
  trays[0]?.emit("click"); await vi.waitFor(() => { expect(env.menus).toHaveLength(1); });
  expect(env.menus[0]?.find((item) => item.label === "Launch at login")?.checked).toBe(false);
  env.login = true; trays[0]?.emit("right-click"); await vi.waitFor(() => { expect(env.menus).toHaveLength(2); });
  expect(env.menus[1]?.find((item) => item.label === "Launch at login")).toMatchObject({ checked: true, enabled: false });
  app.emit("activate"); app.emit("second-instance");
  await vi.waitFor(() => { expect(remote).toHaveLength(1); });
  app.quit(); expect(env.handlers.size).toBe(0);
});
it("exits a duplicate before registering IPC or allocating windows and tray", async () => {
  env.lock = false; await import("./main.js"); await new Promise((resolve) => setImmediate(resolve));
  expect(env.quit).toBe(true); expect(env.handlers.size).toBe(0); expect(local).toHaveLength(0); expect(trays).toHaveLength(0);
});

it("trusts the exact development UI URL and its settings view while rejecting other pages", async () => {
  app.isPackaged = false;
  vi.stubGlobal("CONTROL_WINDOW_VITE_DEV_SERVER_URL", "http://localhost:5173/");
  await import("./main.js");
  await vi.waitFor(() => { expect(trays).toHaveLength(1); });
  const w = local[0]!;
  expect(w.url).toBe("http://localhost:5173/");
  const sender = { sender: w.webContents, senderFrame: w.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  await env.handlers.get(desktopChannels.saveServer)?.(sender, { serverUrl: "http://localhost:3000" });
  expect(remote[0]?.visible).toBe(true);
  trays[0]?.emit("click"); await vi.waitFor(() => { expect(env.menus).toHaveLength(1); });
  env.menus[0]?.find((item) => item.label === "Server settings")?.click?.({} as never, {} as never, {} as never);
  await vi.waitFor(() => { expect(w.url).toBe("http://localhost:5173/?view=settings"); });
  await expect(env.handlers.get(desktopChannels.readState)?.(sender)).resolves.toMatchObject({ settings: { serverOrigin: "http://localhost:3000" } });
  await w.loadURL("http://localhost:5173/other");
  expect(() => env.handlers.get(desktopChannels.readState)?.(sender)).toThrow("Untrusted desktop sender");
  app.quit();
});

it("starts the real entry point on macOS without the Windows-only app identity method", async () => {
  Reflect.deleteProperty(app, "setAppUserModelId");
  await import("./main.js");
  await vi.waitFor(() => { expect(trays).toHaveLength(1); });
  expect(local[0]?.visible).toBe(true); expect(env.quit).toBe(false);
  app.quit();
});
it("forces explicit tray Quit despite a remote page that cancels beforeunload", async () => {
  await import("./main.js");
  await vi.waitFor(() => { expect(trays).toHaveLength(1); });
  const w = local[0]!;
  const sender = { sender: w.webContents, senderFrame: w.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  await env.handlers.get(desktopChannels.saveServer)?.(sender, { serverUrl: "https://hub.example.test" });
  remote[0]!.preventUnload = true;
  trays[0]?.emit("click"); await vi.waitFor(() => { expect(env.menus).toHaveLength(1); });
  env.menus[0]?.find((item) => item.label === "Quit")?.click?.({} as never, {} as never, {} as never);
  expect(env.quit).toBe(true);
  expect(remote[0]?.unloadAttempts).toBe(0);
  expect(remote[0]?.destroyed).toBe(true); expect(w.destroyed).toBe(true);
  expect(env.handlers.size).toBe(0); expect(env.trayDestructions).toBe(1);
  app.emit("before-quit"); expect(env.trayDestructions).toBe(1);
});
it("keeps the app running when activate's older local load is aborted by settings", async () => {
  await import("./main.js");
  await vi.waitFor(() => { expect(trays).toHaveLength(1); });
  const w = local[0]!;
  let abort!: (reason: unknown) => void;
  w.loadDelay = new Promise<void>((_resolve, reject) => { abort = reject; });
  app.emit("activate"); await new Promise((resolve) => setImmediate(resolve));
  w.loadDelay = undefined;
  trays[0]?.emit("click"); await vi.waitFor(() => { expect(env.menus).toHaveLength(1); });
  env.menus[0]?.find((item) => item.label === "Server settings")?.click?.({} as never, {} as never, {} as never);
  await vi.waitFor(() => { expect(w.url).toContain("?view=settings"); });
  abort(Object.assign(new Error("superseded"), { code: "ERR_ABORTED", errno: -3 }));
  await new Promise((resolve) => setImmediate(resolve));
  expect(env.quit).toBe(false); expect(env.errorBoxes).toBe(0);
  expect(env.handlers.size).toBe(5); expect(env.trayDestructions).toBe(0); expect(w.visible).toBe(true);
  app.quit();
});
