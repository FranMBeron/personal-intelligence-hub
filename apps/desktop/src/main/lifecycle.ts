import type { MenuItemConstructorOptions } from "electron";
import type { DesktopState, LaunchAtLoginState } from "../shared/contracts.js";

export interface LoginItemApi {
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export function readLaunchAtLogin(api: LoginItemApi, requested: boolean, platform: string): LaunchAtLoginState {
  if (platform !== "darwin") return { requested, enabled: false, supported: false };
  try {
    const enabled = api.getLoginItemSettings().openAtLogin;
    return { requested, enabled, supported: enabled === requested };
  } catch {
    return { requested, enabled: false, supported: false };
  }
}

export function setLaunchAtLogin(api: LoginItemApi, requested: boolean, platform: string): LaunchAtLoginState {
  if (platform !== "darwin") return { requested, enabled: false, supported: false };
  let accepted = true;
  try {
    api.setLoginItemSettings({ openAtLogin: requested });
  } catch {
    accepted = false;
  }
  const state = readLaunchAtLogin(api, requested, platform);
  return { ...state, supported: accepted && state.supported };
}

export interface TrayActions {
  open(): unknown;
  retry(): unknown;
  openSettings(): unknown;
  setLaunchAtLogin(enabled: boolean): unknown;
  quit(): unknown;
}

export function buildTrayMenu(state: DesktopState, actions: TrayActions): MenuItemConstructorOptions[] {
  return [
    { label: "Open", click: () => { actions.open(); } },
    { label: "Reconnect", enabled: state.settings.serverOrigin !== null && state.connection.kind !== "checking", click: () => { actions.retry(); } },
    { label: "Server settings", click: () => { actions.openSettings(); } },
    { type: "separator" },
    { label: "Launch at login", type: "checkbox", checked: state.launchAtLogin.enabled, enabled: state.launchAtLogin.supported, click: (item) => { actions.setLaunchAtLogin(item.checked); } },
    { type: "separator" },
    { label: "Quit", click: () => { actions.quit(); } },
  ];
}

interface LifecycleApp {
  requestSingleInstanceLock(): boolean;
  setAppUserModelId?(id: string): void;
  quit(): void;
  whenReady(): Promise<unknown>;
  on(event: string, listener: () => void): unknown;
}
interface LifecycleController {
  start(): Promise<void>;
  open(): Promise<void>;
  prepareQuit(): void;
}

export function wireApplicationLifecycle(
  app: LifecycleApp,
  controller: LifecycleController,
  onError: () => void = () => undefined,
  platform: string = process.platform,
): void {
  if (platform === "win32" && typeof app.setAppUserModelId === "function") {
    app.setAppUserModelId("org.personal-intelligence-hub.desktop");
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => { void controller.open().catch(onError); });
  app.on("activate", () => { void controller.open().catch(onError); });
  app.on("before-quit", () => { controller.prepareQuit(); });
  // Windows hide on close; the tray remains available until an explicit Quit.
  app.on("window-all-closed", () => undefined);
  void app.whenReady().then(() => controller.start()).catch(onError);
}
