export type DesktopSettings = Readonly<{
  serverOrigin: string | null;
  launchAtLogin: boolean;
}>;

export type ConnectionState =
  | Readonly<{ kind: "unconfigured" }>
  | Readonly<{ kind: "checking"; origin: string }>
  | Readonly<{ kind: "connected"; origin: string }>
  | Readonly<{ kind: "unavailable"; origin: string; reason: string }>;

export type LaunchAtLoginState = Readonly<{
  requested: boolean;
  enabled: boolean;
  supported: boolean;
}>;

export type DesktopState = Readonly<{
  settings: DesktopSettings;
  connection: ConnectionState;
  launchAtLogin: LaunchAtLoginState;
}>;

export type DesktopBridge = Readonly<{
  readState(): Promise<DesktopState>;
  validateServer(serverUrl: string): Promise<ConnectionState>;
  saveServer(serverUrl: string): Promise<ConnectionState>;
  retry(): Promise<ConnectionState>;
  setLaunchAtLogin(enabled: boolean): Promise<LaunchAtLoginState>;
}>;

export const desktopChannels = {
  readState: "desktop:read-state",
  validateServer: "desktop:validate-server",
  saveServer: "desktop:save-server",
  retry: "desktop:retry",
  setLaunchAtLogin: "desktop:set-launch-at-login",
} as const;
