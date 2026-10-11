import type { DesktopBridge } from "./shared/contracts.js";

declare global {
  const CONTROL_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const CONTROL_WINDOW_VITE_NAME: string;
  interface Window {
    readonly desktop: DesktopBridge;
  }
}

export {};
