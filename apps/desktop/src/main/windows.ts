import { BrowserWindow, screen } from "electron";
import type { BrowserWindowConstructorOptions, WebPreferences } from "electron";

import { confirmExternalLink } from "./external-links.js";
import { installRemotePolicy, type ConfirmExternal } from "./remote-policy.js";

export interface RemoteWindowOptions {
  allowedOrigin: URL;
  confirmExternal?: ConfirmExternal;
}

function sandboxPreferences(): WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
  };
}

interface WindowSize { width: number; height: number; minWidth: number; minHeight: number }
type WindowBounds = Pick<BrowserWindowConstructorOptions, "width" | "height" | "minWidth" | "minHeight">;

const REMOTE_SIZE: WindowSize = { width: 1024, height: 768, minWidth: 480, minHeight: 640 };
const CONTROL_SIZE: WindowSize = { width: 720, height: 700, minWidth: 480, minHeight: 640 };

// Never open larger than the primary display's work area; minimums shrink with it.
function fitToWorkArea(size: WindowSize): WindowBounds {
  const { width: areaWidth, height: areaHeight } = screen.getPrimaryDisplay().workArea;
  if (!(areaWidth > 0 && areaHeight > 0)) return { ...size };
  return {
    width: Math.min(size.width, areaWidth),
    height: Math.min(size.height, areaHeight),
    minWidth: Math.min(size.minWidth, areaWidth),
    minHeight: Math.min(size.minHeight, areaHeight),
  };
}

export function createRemoteWindow(options: RemoteWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    ...fitToWorkArea(REMOTE_SIZE),
    webPreferences: { ...sandboxPreferences(), partition: "persist:pih-remote" },
  });
  const dispose = installRemotePolicy(
    window.webContents,
    window.webContents.session,
    options.allowedOrigin,
    options.confirmExternal ?? confirmExternalLink,
  );
  window.once("closed", dispose);
  // Electron emits did-fail-load for recovery; contain the matching promise rejection.
  void window.loadURL(options.allowedOrigin.href).catch(() => undefined);
  return window;
}

// The caller loads the packaged control renderer (or the Forge development URL).
export function createControlWindow(options: { preloadPath: string }): BrowserWindow {
  return new BrowserWindow({
    ...fitToWorkArea(CONTROL_SIZE),
    webPreferences: { ...sandboxPreferences(), preload: options.preloadPath },
  });
}
