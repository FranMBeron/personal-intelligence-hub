import type { BrowserWindow, Event, IpcMainInvokeEvent } from "electron";
import type { ConnectionState, DesktopBridge, DesktopSettings, DesktopState, LaunchAtLoginState } from "../shared/contracts.js";
import { readLaunchAtLogin, setLaunchAtLogin, type LoginItemApi } from "./lifecycle.js";
import { normalizeServerOrigin } from "./server-origin.js";
import type { SettingsStore } from "./settings-store.js";

interface ControllerDependencies {
  store: SettingsStore;
  controlUrl: string;
  createRemoteWindow(origin: URL): BrowserWindow;
  createControlWindow(): BrowserWindow;
  checkServer(origin: URL): Promise<ConnectionState>;
  loginItem: LoginItemApi;
  platform: string;
  quit(): void;
  allowInsecureLoopback?: boolean;
}

export class DesktopController implements DesktopBridge {
  private settings: DesktopSettings = { serverOrigin: null, launchAtLogin: false };
  private connection: ConnectionState = { kind: "unconfigured" };
  private remoteWindow: BrowserWindow | undefined;
  private remoteOrigin: string | undefined;
  private controlWindow: BrowserWindow | undefined;
  private quitting = false;
  private surfaceRevision = 0;
  private started: Promise<void> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly settingsUrl: string;
  private readonly allowedControlUrls: Set<string>;

  constructor(private readonly dependencies: ControllerDependencies) {
    const settingsUrl = new URL(dependencies.controlUrl);
    settingsUrl.searchParams.set("view", "settings");
    this.settingsUrl = settingsUrl.href;
    this.allowedControlUrls = new Set([dependencies.controlUrl, this.settingsUrl]);
  }

  start(): Promise<void> {
    this.started ??= (async () => {
      this.settings = await this.dependencies.store.read();
      await this.connect();
    })();
    return this.started;
  }

  async readState(): Promise<DesktopState> {
    // Do not wait on start: the local renderer may read while a health check runs.
    return {
      settings: { ...this.settings },
      connection: { ...this.connection },
      launchAtLogin: readLaunchAtLogin(this.dependencies.loginItem, this.settings.launchAtLogin, this.dependencies.platform),
    };
  }

  async open(): Promise<void> {
    await this.start();
    if (this.quitting) return;
    if (this.connection.kind === "connected") this.showRemote(new URL(this.connection.origin));
    else await this.showControl();
  }

  async openSettings(): Promise<void> {
    await this.start();
    await this.showControl(true);
  }

  async validateServer(serverUrl: string): Promise<ConnectionState> {
    return this.dependencies.checkServer(this.serverUrl(serverUrl));
  }

  async saveServer(serverUrl: string): Promise<ConnectionState> {
    const origin = this.serverUrl(serverUrl);
    await this.start();
    return this.serialize(async () => {
      const connection = await this.dependencies.checkServer(origin);
      if (this.quitting || connection.kind !== "connected") return connection;
      const next = { ...this.settings, serverOrigin: origin.origin };
      await this.dependencies.store.write(next);
      this.settings = next;
      this.connection = connection;
      if (!this.quitting) this.showRemote(origin);
      return this.connection;
    });
  }

  async retry(): Promise<ConnectionState> {
    await this.start();
    return this.serialize(() => this.connect());
  }

  async setLaunchAtLogin(enabled: boolean): Promise<LaunchAtLoginState> {
    await this.start();
    return this.serialize(async () => {
      const next = { ...this.settings, launchAtLogin: enabled };
      await this.dependencies.store.write(next);
      this.settings = next;
      return setLaunchAtLogin(this.dependencies.loginItem, enabled, this.dependencies.platform);
    });
  }

  isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const window = this.controlWindow;
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
    const frame = event.senderFrame;
    return frame !== null && frame === window.webContents.mainFrame &&
      this.allowedControlUrls.has(frame.url) &&
      this.allowedControlUrls.has(window.webContents.getURL());
  }

  prepareQuit(): void { this.quitting = true; }

  quit(): void {
    this.prepareQuit();
    this.dependencies.quit();
  }

  private serverUrl(input: string): URL {
    return normalizeServerOrigin(input, { allowInsecureLoopback: this.dependencies.allowInsecureLoopback === true });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async connect(): Promise<ConnectionState> {
    if (this.quitting) return this.connection;
    const origin = this.settings.serverOrigin;
    if (origin === null) {
      this.connection = { kind: "unconfigured" };
      await this.showControl();
      return this.connection;
    }
    this.connection = { kind: "checking", origin };
    const connection = await this.dependencies.checkServer(this.serverUrl(origin));
    if (this.quitting) return this.connection;
    this.connection = connection;
    if (connection.kind === "connected") this.showRemote(new URL(origin));
    else {
      this.destroyRemote();
      await this.showControl();
    }
    return this.connection;
  }

  private hideOnClose(window: BrowserWindow): void {
    window.on("close", (event: Event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });
  }

  private async showControl(settings = false): Promise<void> {
    if (this.quitting) return;
    const revision = ++this.surfaceRevision;
    this.remoteWindow?.hide();
    if (!this.controlWindow || this.controlWindow.isDestroyed()) {
      const window = this.dependencies.createControlWindow();
      this.controlWindow = window;
      this.hideOnClose(window);
      const blockNavigation = (event: Event & { url: string }) => {
        if (!this.allowedControlUrls.has(event.url)) event.preventDefault();
      };
      window.webContents.on("will-navigate", blockNavigation);
      window.webContents.on("will-redirect", blockNavigation);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.once("closed", () => { if (this.controlWindow === window) this.controlWindow = undefined; });
    }
    const window = this.controlWindow;
    await window.loadURL(settings ? this.settingsUrl : this.dependencies.controlUrl);
    if (!this.quitting && revision === this.surfaceRevision && !window.isDestroyed()) { window.show(); window.focus(); }
  }

  private showRemote(origin: URL): void {
    if (this.quitting) return;
    this.surfaceRevision += 1;
    if (this.remoteOrigin !== origin.origin || this.remoteWindow?.isDestroyed()) this.destroyRemote();
    if (!this.remoteWindow) {
      const window = this.dependencies.createRemoteWindow(origin);
      this.remoteWindow = window;
      this.remoteOrigin = origin.origin;
      this.hideOnClose(window);
      window.once("closed", () => {
        if (this.remoteWindow === window) { this.remoteWindow = undefined; this.remoteOrigin = undefined; }
      });
      window.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
        if (!isMainFrame || code === -3 || this.quitting || this.remoteWindow !== window) return;
        this.connection = { kind: "unavailable", origin: origin.origin, reason: "load-failed" };
        this.destroyRemote();
        void this.showControl().catch(() => undefined);
      });
    }
    this.controlWindow?.hide();
    this.remoteWindow.show();
    this.remoteWindow.focus();
  }

  private destroyRemote(): void {
    const window = this.remoteWindow;
    this.remoteWindow = undefined;
    this.remoteOrigin = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
