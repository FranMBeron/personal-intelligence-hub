import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { buildTrayMenu, readLaunchAtLogin, setLaunchAtLogin, wireApplicationLifecycle } from "./lifecycle.js";
import type { DesktopState } from "../shared/contracts.js";

describe("launch at login", () => {
  it("reads the OS checkbox even when it differs from the saved request", () => {
    expect(readLaunchAtLogin({ getLoginItemSettings: () => ({ openAtLogin: true }), setLoginItemSettings: () => undefined }, false, "darwin"))
      .toEqual({ requested: false, enabled: true, supported: false });
  });
  it("sets then reads back the OS state", () => {
    let actual = false; const calls: string[] = [];
    const api = { getLoginItemSettings: () => { calls.push("read"); return { openAtLogin: actual }; }, setLoginItemSettings: ({ openAtLogin }: { openAtLogin: boolean }) => { calls.push("set"); actual = openAtLogin; } };
    expect(setLaunchAtLogin(api, true, "darwin")).toEqual({ requested: true, enabled: true, supported: true }); expect(calls).toEqual(["set", "read"]);
  });
  it("reports a mismatch or rejected OS request honestly", () => {
    const api = { getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => undefined };
    expect(setLaunchAtLogin(api, true, "darwin")).toEqual({ requested: true, enabled: false, supported: false });
    expect(setLaunchAtLogin({ ...api, setLoginItemSettings: () => { throw new Error("fixture"); } }, true, "darwin"))
      .toEqual({ requested: true, enabled: false, supported: false });
  });
  it("does not call unavailable OS APIs on other platforms or claim read failures succeeded", () => {
    const api = { getLoginItemSettings: () => { throw new Error("fixture"); }, setLoginItemSettings: () => { throw new Error("must not call"); } };
    expect(setLaunchAtLogin(api, true, "linux")).toEqual({ requested: true, enabled: false, supported: false });
    expect(readLaunchAtLogin(api, false, "darwin")).toEqual({ requested: false, enabled: false, supported: false });
  });
});
describe("tray state", () => {
  it("builds actions using actual checkbox state and current connection", () => {
    const invoked: string[] = [];
    const actions = { open: () => { invoked.push("open"); }, retry: () => { invoked.push("retry"); }, openSettings: () => { invoked.push("settings"); }, setLaunchAtLogin: (enabled: boolean) => { invoked.push(`login:${enabled}`); }, quit: () => { invoked.push("quit"); } };
    const state: DesktopState = { settings: { serverOrigin: null, launchAtLogin: false }, connection: { kind: "unconfigured" }, launchAtLogin: { requested: false, enabled: true, supported: true } };
    const first = buildTrayMenu(state, actions);
    expect(first.find((i) => i.label === "Reconnect")?.enabled).toBe(false);
    expect(first.find((i) => i.label === "Launch at login")?.checked).toBe(true);
    const connected = buildTrayMenu({ ...state, settings: { ...state.settings, serverOrigin: "https://hub.example.test" }, connection: { kind: "connected", origin: "https://hub.example.test" }, launchAtLogin: { requested: true, enabled: false, supported: false } }, actions);
    expect(connected.find((i) => i.label === "Reconnect")?.enabled).toBe(true);
    expect(connected.find((i) => i.label === "Launch at login")).toMatchObject({ checked: false, enabled: false });
    for (const item of first) item.click?.({ checked: false } as never, {} as never, {} as never);
    expect(invoked).toEqual(["open", "retry", "settings", "login:false", "quit"]);
  });
});
describe("application lifecycle", () => {
  it("quits a duplicate instance before starting the controller", async () => {
    const app = Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => false, setAppUserModelId: () => undefined, quit: () => { stopped = true; }, whenReady: async () => undefined });
    let stopped = false; let started = false;
    wireApplicationLifecycle(app, { start: async () => { started = true; }, open: async () => undefined, prepareQuit: () => undefined });
    await new Promise((resolve) => setImmediate(resolve)); expect(stopped).toBe(true); expect(started).toBe(false);
  });
  it("starts once ready, routes activate/second instance to open, and permits OS Quit", async () => {
    const calls: string[] = [];
    const app = Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => true, setAppUserModelId: (id: string) => { calls.push(id); }, quit: () => undefined, whenReady: async () => undefined });
    wireApplicationLifecycle(app, { start: async () => { calls.push("start"); }, open: async () => { calls.push("open"); }, prepareQuit: () => { calls.push("quit"); } });
    await new Promise((resolve) => setImmediate(resolve)); app.emit("activate"); app.emit("second-instance"); app.emit("before-quit"); app.emit("window-all-closed");
    expect(calls).toEqual(["org.personal-intelligence-hub.desktop", "start", "open", "open", "quit"]);
  });
});
