import { BrowserWindow } from "electron";
import type { WebPreferences } from "electron";

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

export function createRemoteWindow(options: RemoteWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
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
    webPreferences: { ...sandboxPreferences(), preload: options.preloadPath },
  });
}
