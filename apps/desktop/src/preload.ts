import { contextBridge, ipcRenderer } from "electron";

import { desktopChannels, type DesktopBridge } from "./shared/contracts.js";

contextBridge.exposeInMainWorld("desktop", Object.freeze({
  readState: () => ipcRenderer.invoke(desktopChannels.readState),
  validateServer: (serverUrl: string) => ipcRenderer.invoke(desktopChannels.validateServer, { serverUrl }),
  saveServer: (serverUrl: string) => ipcRenderer.invoke(desktopChannels.saveServer, { serverUrl }),
  retry: () => ipcRenderer.invoke(desktopChannels.retry),
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke(desktopChannels.setLaunchAtLogin, { enabled }),
} satisfies DesktopBridge));
