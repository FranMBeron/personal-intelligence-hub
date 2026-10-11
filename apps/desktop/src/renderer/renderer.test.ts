// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionState, DesktopBridge, DesktopState } from "../shared/contracts.js";
import { mountControlSurface } from "./renderer.js";

let root: HTMLElement;
let state: DesktopState;
let bridge: { -readonly [K in keyof DesktopBridge]: DesktopBridge[K] };
const connected: ConnectionState = { kind: "connected", origin: "https://hub.example.test" };
const unavailable: ConnectionState = { kind: "unavailable", origin: "https://hub.example.test", reason: "network-error" };

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.append(root);
  state = {
    settings: { serverOrigin: null, launchAtLogin: false },
    connection: { kind: "unconfigured" },
    launchAtLogin: { requested: false, enabled: false, supported: true },
  };
  bridge = {
    readState: vi.fn(async () => state),
    validateServer: vi.fn(async () => connected),
    saveServer: vi.fn(async () => {
      state = { ...state, settings: { ...state.settings, serverOrigin: "https://hub.example.test" }, connection: connected };
      return connected;
    }),
    retry: vi.fn(async () => unavailable),
    setLaunchAtLogin: vi.fn(async (enabled) => ({ requested: enabled, enabled, supported: true })),
  };
});

function submit(value: string) {
  const input = root.querySelector<HTMLInputElement>("#server-url");
  if (!input) throw new Error("Server form missing");
  input.value = value;
  root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
function button(label: string) {
  const found = Array.from(root.querySelectorAll("button")).find((element) => element.textContent === label);
  if (!found) throw new Error(`Button missing: ${label}`);
  return found;
}
async function settled() { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("local control surface", () => {
  it("shows an empty labelled server form on first launch with configuration content only", async () => {
    await mountControlSurface(root, bridge);
    expect(root.dataset.view).toBe("setup");
    expect(root.querySelector("h1")?.textContent).toBe("Connect your Hub");
    expect(root.querySelector("label[for=server-url]")?.textContent).toBe("Server URL");
    expect(root.querySelector<HTMLInputElement>("#server-url")?.value).toBe("");
    expect(root.querySelectorAll("article, table, iframe")).toHaveLength(0);
    expect(root.textContent).not.toMatch(/sample|priorit|agents|notes|metrics|records/i);
    expect(bridge.saveServer).not.toHaveBeenCalled();
  });

  it("keeps settings unchanged and shows a concise error when URL validation rejects", async () => {
    bridge.validateServer = vi.fn(async () => { throw new Error("unsafe private input"); });
    await mountControlSurface(root, bridge);
    submit("http://hub.example.test");
    await settled();
    expect(bridge.saveServer).not.toHaveBeenCalled();
    expect(state.settings.serverOrigin).toBeNull();
    expect(root.querySelector("[role=alert]")?.textContent).toMatch(/HTTPS server origin/);
    expect(root.textContent).not.toContain("unsafe private input");
    expect(root.querySelector<HTMLInputElement>("#server-url")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("shows checking while validation is pending and disables duplicate submissions", async () => {
    let finish!: (value: ConnectionState) => void;
    bridge.validateServer = vi.fn(() => new Promise<ConnectionState>((resolve) => { finish = resolve; }));
    await mountControlSurface(root, bridge);
    submit("https://hub.example.test");
    expect(root.dataset.view).toBe("checking");
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
    root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(bridge.validateServer).toHaveBeenCalledOnce();
    finish(unavailable);
    await settled();
    expect(bridge.saveServer).not.toHaveBeenCalled();
    expect(state.settings.serverOrigin).toBeNull();
    expect(root.dataset.view).toBe("unavailable");
  });

  it("shows recovery controls for an unavailable configured server and retries it", async () => {
    state = { ...state, settings: { ...state.settings, serverOrigin: "https://hub.example.test" }, connection: unavailable };
    await mountControlSurface(root, bridge);
    expect(root.dataset.view).toBe("unavailable");
    button("Retry").click();
    expect(root.dataset.view).toBe("checking");
    await settled();
    expect(bridge.retry).toHaveBeenCalledExactlyOnceWith();
    button("Server settings").click();
    expect(root.dataset.view).toBe("settings");
    expect(root.querySelector<HTMLInputElement>("#server-url")?.value).toBe("https://hub.example.test");
  });

  it("validates before requesting a save and remote app opening through the main process", async () => {
    await mountControlSurface(root, bridge);
    submit("https://HUB.example.test/");
    await settled();
    expect(bridge.validateServer).toHaveBeenCalledExactlyOnceWith("https://HUB.example.test/");
    expect(bridge.saveServer).toHaveBeenCalledExactlyOnceWith("https://hub.example.test");
    expect(root.querySelector("[role=status]")?.textContent).toContain("Opening your Hub");
    expect(root.querySelector("iframe, a[href]")).toBeNull();
  });

  it("returns to editable settings if saving fails after validation", async () => {
    bridge.saveServer = vi.fn(async () => { throw new Error("private filesystem detail"); });
    await mountControlSurface(root, bridge);
    submit("https://hub.example.test");
    await settled();
    expect(root.dataset.view).toBe("setup");
    expect(root.querySelector("[role=alert]")?.textContent).toContain("Unable to save server settings");
    expect(root.textContent).not.toContain("private filesystem detail");
    expect(root.querySelector<HTMLInputElement>("#server-url")?.value).toBe("https://hub.example.test");
  });

  it("supports explicitly opening settings even while connected", async () => {
    state = { ...state, connection: connected, settings: { ...state.settings, serverOrigin: "https://hub.example.test" } };
    await mountControlSurface(root, bridge, { view: "settings" });
    expect(root.dataset.view).toBe("settings");
    expect(root.querySelector("form")).not.toBeNull();
  });

  it("uses actual OS login state even when the stored preference differs", async () => {
    state = { ...state, settings: { ...state.settings, launchAtLogin: true }, launchAtLogin: { requested: true, enabled: false, supported: false } };
    await mountControlSurface(root, bridge);
    const checkbox = root.querySelector<HTMLInputElement>("#launch-at-login");
    expect(checkbox?.checked).toBe(false);
    expect(checkbox?.disabled).toBe(true);
    expect(root.querySelector("#login-status")?.textContent).toMatch(/unavailable|unsupported/i);
    expect(root.querySelector("#login-status")?.textContent).toContain("off");
  });

  it("reads back reported login state instead of displaying the requested value", async () => {
    bridge.setLaunchAtLogin = vi.fn(async () => ({ requested: true, enabled: false, supported: false }));
    await mountControlSurface(root, bridge);
    const checkbox = root.querySelector<HTMLInputElement>("#launch-at-login")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await settled();
    expect(bridge.setLaunchAtLogin).toHaveBeenCalledExactlyOnceWith(true);
    expect(root.querySelector<HTMLInputElement>("#launch-at-login")?.checked).toBe(false);
    expect(root.querySelector<HTMLInputElement>("#launch-at-login")?.disabled).toBe(true);
  });

  it("restores the reported login value on failure without marking the server URL invalid", async () => {
    bridge.setLaunchAtLogin = vi.fn(async () => { throw new Error("private native detail"); });
    await mountControlSurface(root, bridge);
    const checkbox = root.querySelector<HTMLInputElement>("#launch-at-login")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await settled();
    expect(root.querySelector<HTMLInputElement>("#launch-at-login")?.checked).toBe(false);
    expect(root.querySelector<HTMLInputElement>("#server-url")?.getAttribute("aria-invalid")).toBe("false");
    expect(root.querySelector("[role=alert]")?.textContent).toContain("Unable to update launch at login");
    expect(root.textContent).not.toContain("private native detail");
  });

  it("preserves an unsaved server address when changing launch at login", async () => {
    await mountControlSurface(root, bridge);
    const input = root.querySelector<HTMLInputElement>("#server-url")!;
    input.value = "https://new.example.test";
    input.dispatchEvent(new Event("input"));
    const checkbox = root.querySelector<HTMLInputElement>("#launch-at-login")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await settled();
    expect(root.querySelector<HTMLInputElement>("#server-url")?.value).toBe("https://new.example.test");
    expect(state.settings.serverOrigin).toBeNull();
  });

  it("contains native failures and offers a retry without exposing the error", async () => {
    bridge.readState = vi.fn(async () => { throw new Error("private local path"); });
    await mountControlSurface(root, bridge);
    expect(root.querySelector("[role=alert]")?.textContent).toContain("Unable to read desktop settings");
    expect(root.textContent).not.toContain("private local path");
    bridge.readState = vi.fn(async () => state);
    button("Retry").click();
    await settled();
    expect(root.dataset.view).toBe("setup");
  });
});
