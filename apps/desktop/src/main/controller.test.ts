import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopController } from "./controller.js";
import { SettingsStore } from "./settings-store.js";
import type { ConnectionState } from "../shared/contracts.js";

class WindowFixture extends EventEmitter {
  visible = false;
  destroyed = false;
  destroyCalls = 0;
  url = "";
  loadDelay: Promise<void> | undefined;
  newWindowHandler: (() => { action: string }) | undefined;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "" },
    getURL: () => this.url,
    setWindowOpenHandler: (handler: () => { action: string }) => { this.newWindowHandler = handler; },
  });
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() { this.visible = true; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyCalls += 1; this.destroyed = true; this.visible = false; this.emit("closed"); }
  async loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; await this.loadDelay; }
  asWindow() { return this as unknown as BrowserWindow; }
}
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(origin: string | null = null, overrideCheck?: (url: URL) => Promise<ConnectionState>) {
  const directory = await mkdtemp(join(tmpdir(), "pih-controller-"));
  directories.push(directory);
  const store = new SettingsStore(directory);
  await store.write({ serverOrigin: origin, launchAtLogin: false });
  let healthy = true;
  let quit = false;
  let osLogin = false;
  let rejectLogin = false;
  const remote: WindowFixture[] = [];
  const local: WindowFixture[] = [];
  const checked: string[] = [];
  const controller = new DesktopController({
    store, controlUrl: "file:///app/renderer/index.html",
    createRemoteWindow: () => { const w = new WindowFixture(); remote.push(w); return w.asWindow(); },
    createControlWindow: () => { const w = new WindowFixture(); local.push(w); return w.asWindow(); },
    checkServer: overrideCheck ?? (async (url: URL): Promise<ConnectionState> => {
      checked.push(url.origin);
      return healthy ? { kind: "connected", origin: url.origin } : { kind: "unavailable", origin: url.origin, reason: "network-error" };
    }),
    platform: "darwin",
    loginItem: { getLoginItemSettings: () => ({ openAtLogin: osLogin }), setLoginItemSettings: ({ openAtLogin }) => { if (!rejectLogin) osLogin = openAtLogin; } },
    quit: () => { quit = true; },
  });
  return { controller, store, remote, local, checked, unhealthy: () => { healthy = false; }, healthy: () => { healthy = true; }, didQuit: () => quit, rejectLogin: () => { rejectLogin = true; } };
}
describe("desktop controller", () => {
  it("opens local setup without probing an unconfigured server", async () => {
    const f = await fixture(); await f.controller.start();
    expect(f.local[0]?.visible).toBe(true); expect(f.remote).toHaveLength(0); expect(f.checked).toEqual([]);
    expect((await f.controller.readState()).connection).toEqual({ kind: "unconfigured" });
  });
  it("opens a healthy configured server once and reuses its hidden window on activate", async () => {
    const f = await fixture("https://hub.example.test"); await f.controller.start(); await f.controller.start();
    expect(f.remote[0]?.visible).toBe(true); expect(f.local).toHaveLength(0); expect(f.remote).toHaveLength(1);
    let prevented = false; f.remote[0]?.emit("close", { preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true); expect(f.remote[0]?.visible).toBe(false); expect(f.didQuit()).toBe(false);
    await f.controller.open(); expect(f.remote[0]?.visible).toBe(true);
  });
  it("uses local recovery for unavailable servers and reconnects after retry", async () => {
    const f = await fixture("https://hub.example.test"); f.unhealthy(); await f.controller.start();
    expect(f.local[0]?.visible).toBe(true); expect(f.remote).toHaveLength(0);
    f.healthy(); expect(await f.controller.retry()).toEqual({ kind: "connected", origin: "https://hub.example.test" });
    expect(f.remote[0]?.visible).toBe(true); expect(f.local[0]?.visible).toBe(false);
  });
  it("opens local settings, validates without persisting, then saves and replaces the old remote", async () => {
    const f = await fixture("https://hub.example.test"); await f.controller.start(); await f.controller.openSettings();
    expect(f.local[0]?.url).toBe("file:///app/renderer/index.html?view=settings");
    expect(f.remote[0]?.visible).toBe(false);
    expect(await f.controller.validateServer("https://new.example.test")).toEqual({ kind: "connected", origin: "https://new.example.test" });
    expect((await f.store.read()).serverOrigin).toBe("https://hub.example.test");
    await f.controller.saveServer("https://new.example.test");
    expect((await f.store.read()).serverOrigin).toBe("https://new.example.test");
    expect(f.remote[0]?.destroyed).toBe(true); expect(f.remote[1]?.visible).toBe(true);
  });
  it("keeps the configured server when validation fails or the candidate is unsafe", async () => {
    const f = await fixture("https://hub.example.test"); await f.controller.start(); f.unhealthy();
    expect((await f.controller.saveServer("https://new.example.test")).kind).toBe("unavailable");
    await expect(f.controller.saveServer("http://unsafe.example.test")).rejects.toThrow();
    expect((await f.store.read()).serverOrigin).toBe("https://hub.example.test");
  });
  it("recovers from main-frame load failure, ignoring subframes and intentional aborts", async () => {
    const f = await fixture("https://hub.example.test"); await f.controller.start();
    f.remote[0]?.webContents.emit("did-fail-load", {}, -105, "fixture", "https://hub.example.test", false);
    f.remote[0]?.webContents.emit("did-fail-load", {}, -3, "fixture", "https://hub.example.test", true);
    expect(f.local).toHaveLength(0);
    f.remote[0]?.webContents.emit("did-fail-load", {}, -105, "fixture", "https://hub.example.test", true);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await f.controller.readState()).connection).toEqual({ kind: "unavailable", origin: "https://hub.example.test", reason: "load-failed" });
    expect(f.local[0]?.visible).toBe(true); expect(f.remote[0]?.destroyed).toBe(true);
    await f.controller.open(); expect(f.local[0]?.visible).toBe(true);
  });
  it("recovers from an HTTP proxy error page instead of leaving a blank remote window", async () => {
    const f = await fixture("https://hub.example.test"); await f.controller.start();
    f.remote[0]?.webContents.emit("did-navigate", {}, "https://hub.example.test", 200, "OK");
    expect(f.local).toHaveLength(0);
    f.remote[0]?.webContents.emit("did-navigate", {}, "https://hub.example.test", 502, "Bad Gateway");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await f.controller.readState()).connection).toEqual({ kind: "unavailable", origin: "https://hub.example.test", reason: "http-error" });
    expect(f.local[0]?.visible).toBe(true);
    expect(f.remote[0]?.destroyed).toBe(true);
    f.healthy(); await f.controller.retry();
    expect(f.remote[1]?.visible).toBe(true);
    f.remote[0]?.webContents.emit("did-navigate", {}, "https://hub.example.test", 503, "Unavailable");
    expect(f.remote[1]?.destroyed).toBe(false);
  });
  it("hides local windows on close and allows explicit Quit to terminate", async () => {
    const f = await fixture(); await f.controller.start();
    let prevented = false; f.local[0]?.emit("close", { preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true); expect(f.local[0]?.visible).toBe(false);
    f.controller.quit(); expect(f.didQuit()).toBe(true);
    prevented = false; f.local[0]?.emit("close", { preventDefault: () => { prevented = true; } }); expect(prevented).toBe(false);
  });
  it("persists requested login preference and returns actual OS state", async () => {
    const f = await fixture(); await f.controller.start();
    expect(await f.controller.setLaunchAtLogin(true)).toEqual({ requested: true, enabled: true, supported: true });
    expect((await f.store.read()).launchAtLogin).toBe(true);
  });
  it("persists a rejected login request while reporting the actual OS checkbox", async () => {
    const f = await fixture(); await f.controller.start(); f.rejectLogin();
    expect(await f.controller.setLaunchAtLogin(true)).toEqual({ requested: true, enabled: false, supported: false });
    expect((await f.store.read()).launchAtLogin).toBe(true);
    expect((await f.controller.readState()).launchAtLogin).toEqual({ requested: true, enabled: false, supported: false });
  });
  it("does not open windows when a pending initial health check finishes after Quit", async () => {
    let resolve!: (state: ConnectionState) => void;
    const waiting = new Promise<ConnectionState>((done) => { resolve = done; });
    let entered!: () => void;
    const checking = new Promise<void>((done) => { entered = done; });
    const f = await fixture("https://hub.example.test", () => { entered(); return waiting; });
    const start = f.controller.start(); await checking; f.controller.quit();
    resolve({ kind: "connected", origin: "https://hub.example.test" }); await start;
    expect(f.local).toHaveLength(0); expect(f.remote).toHaveLength(0);
  });
  it("keeps the remote foreground when an older local load finishes after reconnect", async () => {
    const f = await fixture("https://hub.example.test"); f.unhealthy(); await f.controller.start();
    let release!: () => void;
    f.local[0]!.loadDelay = new Promise<void>((done) => { release = done; });
    const opening = f.controller.open();
    await new Promise((resolve) => setImmediate(resolve));
    f.healthy(); await f.controller.retry(); release(); await opening;
    expect(f.remote[0]?.visible).toBe(true); expect(f.local[0]?.visible).toBe(false);
  });
  it("ignores retired remote failures after changing server", async () => {
    const f = await fixture("https://hub.example.test"); await f.controller.start();
    const retired = f.remote[0]!; await f.controller.saveServer("https://new.example.test");
    retired.webContents.emit("did-fail-load", {}, -105, "fixture", "https://hub.example.test", true);
    expect((await f.controller.readState()).connection).toEqual({ kind: "connected", origin: "https://new.example.test" });
    expect(f.remote[1]?.visible).toBe(true); expect(f.local).toHaveLength(0);
  });
  it("destroys both owned windows exactly once before explicit Quit", async () => {
    const f = await fixture("https://hub.example.test");
    await f.controller.start(); await f.controller.openSettings();
    f.controller.quit(); f.controller.prepareQuit(); f.controller.quit();
    expect(f.didQuit()).toBe(true);
    expect(f.remote[0]?.destroyed).toBe(true); expect(f.local[0]?.destroyed).toBe(true);
    expect(f.remote[0]?.destroyCalls).toBe(1); expect(f.local[0]?.destroyCalls).toBe(1);
    await f.controller.open(); expect(f.remote).toHaveLength(1); expect(f.local).toHaveLength(1);
  });
  it("contains an aborted older local load when a newer settings view takes over", async () => {
    const f = await fixture(); await f.controller.start(); const w = f.local[0]!;
    let abort!: (reason: unknown) => void;
    w.loadDelay = new Promise<void>((_resolve, reject) => { abort = reject; });
    const opening = f.controller.open();
    const result = opening.then(() => "resolved", () => "rejected");
    await new Promise((resolve) => setImmediate(resolve));
    w.loadDelay = undefined; await f.controller.openSettings();
    abort(Object.assign(new Error("superseded"), { code: "ERR_ABORTED", errno: -3 }));
    expect(await result).toBe("resolved");
    expect(w.url).toBe("file:///app/renderer/index.html?view=settings"); expect(w.visible).toBe(true);
  });
  it("surfaces a current local load failure rather than suppressing it", async () => {
    const f = await fixture(); await f.controller.start(); const w = f.local[0]!;
    let reject!: (reason: unknown) => void;
    w.loadDelay = new Promise<void>((_resolve, fail) => { reject = fail; });
    const opening = f.controller.open();
    const assertion = expect(opening).rejects.toMatchObject({ code: "ERR_FILE_NOT_FOUND" });
    await new Promise((resolve) => setImmediate(resolve));
    reject(Object.assign(new Error("missing UI"), { code: "ERR_FILE_NOT_FOUND", errno: -6 }));
    await assertion;
  });
  it("does not reshow a local window closed by its user during a delayed load", async () => {
    const f = await fixture(); await f.controller.start(); const w = f.local[0]!;
    let release!: () => void;
    w.loadDelay = new Promise<void>((resolve) => { release = resolve; });
    const opening = f.controller.open();
    await new Promise((resolve) => setImmediate(resolve));
    w.emit("close", { preventDefault: () => undefined });
    expect(w.visible).toBe(false);
    release(); await opening; expect(w.visible).toBe(false); expect(w.destroyed).toBe(false);
  });
  it("trusts only the owned control main frame at exact permitted local URLs", async () => {
    const f = await fixture(); await f.controller.start(); const w = f.local[0]!;
    const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
    expect(f.controller.isTrustedSender(event)).toBe(true);
    expect(f.controller.isTrustedSender({ ...event, senderFrame: { url: w.url } } as IpcMainInvokeEvent)).toBe(false);
    expect(f.controller.isTrustedSender({ ...event, sender: {} } as IpcMainInvokeEvent)).toBe(false);
    for (const url of ["https://remote.example.test", "file:///app/renderer/other.html", "file:///app/renderer/index.html?view=evil"]) {
      await w.loadURL(url); expect(f.controller.isTrustedSender(event)).toBe(false);
    }
    await f.controller.openSettings(); expect(f.controller.isTrustedSender(event)).toBe(true);
    w.destroy(); expect(f.controller.isTrustedSender(event)).toBe(false);
  });
  it("blocks local navigation away from permitted UI and denies child windows", async () => {
    const f = await fixture(); await f.controller.start(); let prevented = false;
    f.local[0]?.webContents.emit("will-navigate", { url: "https://remote.example.test", preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(f.local[0]?.newWindowHandler?.()).toEqual({ action: "deny" });
  });
});
