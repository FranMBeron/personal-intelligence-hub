import { EventEmitter } from "node:events";
import type { HandlerDetails, Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { installRemotePolicy, isAllowedNavigation } from "./remote-policy.js";

const allowed = new URL("https://hub.example.test");
const denied = { action: "deny" };
type OpenHandler = Parameters<WebContents["setWindowOpenHandler"]>[0];
type PermissionCheck = Parameters<Session["setPermissionCheckHandler"]>[0];
type PermissionRequest = Parameters<Session["setPermissionRequestHandler"]>[0];

function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler(handler: OpenHandler) { open = handler; },
    isDestroyed: () => false,
  });
  const session = Object.assign(new EventEmitter(), {
    setPermissionCheckHandler(handler: PermissionCheck) { check = handler; },
    setPermissionRequestHandler(handler: PermissionRequest) { request = handler; },
  });
  let open: OpenHandler | undefined;
  let check: PermissionCheck;
  let request: PermissionRequest;
  return {
    contents, session,
    webContents: contents as unknown as WebContents,
    electronSession: session as unknown as Session,
    open: (details: HandlerDetails) => open?.(details),
    check: () => check,
    request: () => request,
  };
}
function openDetails(url: string, disposition: HandlerDetails["disposition"] = "foreground-tab"): HandlerDetails {
  return { url, disposition, frameName: "_blank", features: "", referrer: { url: allowed.href, policy: "strict-origin-when-cross-origin" } };
}
function navigation(url: string, isMainFrame = true) {
  return { url, isMainFrame, isSameDocument: false, frame: null, initiator: null, preventDefault: vi.fn() };
}

describe("isAllowedNavigation", () => {
  it.each([
    "https://hub.example.test/second-brain",
    "https://hub.example.test:443/path?next=https://attacker.invalid#section",
    "https://HUB.EXAMPLE.TEST/",
  ])("allows exactly the parsed origin: %s", (target) => {
    expect(isAllowedNavigation(target, allowed)).toBe(true);
  });
  it.each([
    "https://hub.example.test.attacker.invalid",
    "https://hub.example.test:444/",
    "https://attacker.invalid/",
    "http://hub.example.test/",
    "https://user:fixture@hub.example.test/",
    "https://user@hub.example.test/",
    "https://hub.example.test@attacker.invalid/",
    "javascript:alert(1)", "file:///tmp/index.html", "data:text/html,fixture",
    "blob:https://hub.example.test/fixture", "about:blank", "//hub.example.test/",
    "/second-brain", "not a URL", "",
  ])("rejects unsafe navigation: %s", (target) => {
    expect(isAllowedNavigation(target, allowed)).toBe(false);
  });
  it("preserves an explicitly normalized development loopback origin only", () => {
    const loopback = new URL("http://127.0.0.1:3000");
    expect(isAllowedNavigation("http://127.0.0.1:3000/path", loopback)).toBe(true);
    expect(isAllowedNavigation("http://localhost:3000/path", loopback)).toBe(false);
    expect(isAllowedNavigation("https://127.0.0.1:3000/path", loopback)).toBe(false);
  });
});

describe("installRemotePolicy", () => {
  it.each(["will-navigate", "will-redirect"])("blocks cross-origin %s silently, including scripted navigation", (name) => {
    const f = fixture();
    const confirm = vi.fn().mockResolvedValue(true);
    installRemotePolicy(f.webContents, f.electronSession, allowed, confirm);
    const event = navigation("https://attacker.invalid/");
    f.contents.emit(name, event, event.url, false, true, 1, 1);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    const sameOrigin = navigation("https://hub.example.test/second-brain");
    f.contents.emit(name, sameOrigin, sameOrigin.url, false, true, 1, 1);
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
  });
  it("blocks cross-origin subframe redirects as well", () => {
    const f = fixture();
    installRemotePolicy(f.webContents, f.electronSession, allowed, vi.fn());
    const event = navigation("https://attacker.invalid/", false);
    f.contents.emit("will-redirect", event, event.url, false, false, 2, 2);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it.each(["foreground-tab", "background-tab", "new-window"] as const)("always denies %s requests even after confirming external HTTPS", async (disposition) => {
    const f = fixture();
    const confirm = vi.fn().mockResolvedValue(true);
    installRemotePolicy(f.webContents, f.electronSession, allowed, confirm);
    expect(f.open(openDetails("https://external.example.test/docs", disposition))).toEqual(denied);
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledExactlyOnceWith("https://external.example.test/docs");
  });
  it.each(["default", "other"] as const)("denies ambiguous %s requests without confirmation", (disposition) => {
    const f = fixture();
    const confirm = vi.fn();
    installRemotePolicy(f.webContents, f.electronSession, allowed, confirm);
    expect(f.open(openDetails("https://external.example.test/docs", disposition))).toEqual(denied);
    expect(confirm).not.toHaveBeenCalled();
  });
  it.each([
    "https://hub.example.test/path", "http://external.example.test/",
    "https://user:fixture@external.example.test/", "javascript:alert(1)",
    "file:///tmp/index.html", "mailto:user@example.test", "not a URL",
  ])("denies %s without a confirmation", (url) => {
    const f = fixture();
    const confirm = vi.fn();
    installRemotePolicy(f.webContents, f.electronSession, allowed, confirm);
    expect(f.open(openDetails(url))).toEqual(denied);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("keeps a rejected confirmation contained and denied", async () => {
    const f = fixture();
    installRemotePolicy(f.webContents, f.electronSession, allowed, async () => { throw new Error("fixture"); });
    expect(f.open(openDetails("https://external.example.test/"))).toEqual(denied);
    await new Promise((resolve) => setImmediate(resolve));
  });
  it("denies every permission check and request", () => {
    const f = fixture();
    installRemotePolicy(f.webContents, f.electronSession, allowed, vi.fn());
    const check = f.check();
    const request = f.request();
    const callback = vi.fn();
    expect(check?.(f.webContents, "geolocation", allowed.origin, { isMainFrame: true, requestingUrl: allowed.href, embeddingOrigin: allowed.origin })).toBe(false);
    request?.(f.webContents, "notifications", callback, { requestingUrl: allowed.href, isMainFrame: true });
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("prevents session downloads", () => {
    const f = fixture();
    installRemotePolicy(f.webContents, f.electronSession, allowed, vi.fn());
    const event = { preventDefault: vi.fn() };
    f.session.emit("will-download", event, {}, f.webContents);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
  it("cleans up once without removing unrelated listeners or allowing new windows", () => {
    const f = fixture();
    const unrelated = vi.fn();
    f.contents.on("will-navigate", unrelated);
    const dispose = installRemotePolicy(f.webContents, f.electronSession, allowed, vi.fn());
    dispose();
    dispose();
    expect(f.contents.listenerCount("will-navigate")).toBe(1);
    expect(f.contents.listenerCount("will-redirect")).toBe(0);
    expect(f.session.listenerCount("will-download")).toBe(0);
    expect(f.check()).toBeNull();
    expect(f.request()).toBeNull();
    expect(f.open(openDetails("https://external.example.test/"))).toEqual(denied);
  });
  it("keeps shared session denial until the last remote window is disposed", () => {
    const first = fixture();
    const second = fixture();
    const disposeFirst = installRemotePolicy(first.webContents, first.electronSession, allowed, vi.fn());
    const disposeSecond = installRemotePolicy(second.webContents, first.electronSession, allowed, vi.fn());
    expect(first.session.listenerCount("will-download")).toBe(1);
    disposeFirst();
    expect(first.session.listenerCount("will-download")).toBe(1);
    expect(first.check()).not.toBeNull();
    expect(first.request()).not.toBeNull();
    disposeSecond();
    expect(first.session.listenerCount("will-download")).toBe(0);
  });
  it("never loads an OAuth provider in the app and only routes its popup to confirmation", async () => {
    const oauth = "https://accounts.example.test/o/oauth2/auth?client_id=fixture&state=opaque";
    const f = fixture();
    const confirm = vi.fn().mockResolvedValue(false);
    installRemotePolicy(f.webContents, f.electronSession, allowed, confirm);
    for (const name of ["will-navigate", "will-redirect"]) {
      const event = navigation(oauth);
      f.contents.emit(name, event, event.url, false, true, 1, 1);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(f.open(openDetails(oauth))).toEqual(denied);
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledExactlyOnceWith(oauth);
  });
  it("does not ask to open a downgraded HTTP OAuth popup", async () => {
    const f = fixture();
    const confirm = vi.fn();
    installRemotePolicy(f.webContents, f.electronSession, allowed, confirm);
    expect(f.open(openDetails("http://accounts.example.test/o/oauth2/auth?state=opaque"))).toEqual(denied);
    await Promise.resolve();
    expect(confirm).not.toHaveBeenCalled();
  });
});
