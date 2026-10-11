import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { desktopChannels, type DesktopBridge } from "../shared/contracts.js";
import { normalizeServerOrigin } from "./server-origin.js";

export interface DesktopIpcOptions {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
  bridge: DesktopBridge;
  allowInsecureLoopback?: boolean;
}

function field(args: unknown[], key: string, type: "string" | "boolean"): unknown {
  const payload = args[0];
  if (args.length !== 1 || typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Invalid desktop payload");
  }
  const keys = Reflect.ownKeys(payload);
  const descriptor = Object.getOwnPropertyDescriptor(payload, key);
  if (keys.length !== 1 || keys[0] !== key || !descriptor || !("value" in descriptor) || typeof descriptor.value !== type) {
    throw new Error("Invalid desktop payload");
  }
  return descriptor.value;
}

export function registerDesktopIpc(options: DesktopIpcOptions): () => void {
  const { ipcMain, bridge } = options;
  const serverOrigin = (args: unknown[]): string => {
    const input = field(args, "serverUrl", "string") as string;
    try {
      return normalizeServerOrigin(input, { allowInsecureLoopback: options.allowInsecureLoopback === true }).origin;
    } catch {
      throw new Error("Use an HTTPS server origin without credentials, a path, query, or fragment");
    }
  };
  const withoutPayload = (args: unknown[]): void => {
    if (args.length !== 0) throw new Error("Invalid desktop payload");
  };
  const handlers: Record<string, (args: unknown[]) => unknown> = {
    [desktopChannels.readState]: (args) => { withoutPayload(args); return bridge.readState(); },
    [desktopChannels.validateServer]: (args) => bridge.validateServer(serverOrigin(args)),
    [desktopChannels.saveServer]: (args) => bridge.saveServer(serverOrigin(args)),
    [desktopChannels.retry]: (args) => { withoutPayload(args); return bridge.retry(); },
    [desktopChannels.setLaunchAtLogin]: (args) => bridge.setLaunchAtLogin(field(args, "enabled", "boolean") as boolean),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      // Sender identity and its current main-frame URL are checked by the window owner.
      // This guard must stay before any payload inspection or application callback.
      if (!options.isTrustedSender(event)) throw new Error("Untrusted desktop sender");
      return handler(args);
    });
  }
  return () => { for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel); };
}
