import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, dialog, ipcMain, Menu, nativeImage, Tray } from "electron";
import { DesktopController } from "./main/controller.js";
import { checkServer } from "./main/connectivity.js";
import { registerDesktopIpc } from "./main/ipc.js";
import { buildTrayMenu, wireApplicationLifecycle } from "./main/lifecycle.js";
import { SettingsStore } from "./main/settings-store.js";
import { createControlWindow, createRemoteWindow } from "./main/windows.js";
import trayImageData from "../assets/tray-template.png?inline";

app.setName("Personal Intelligence Hub");
let controller: DesktopController | undefined;
let tray: Tray | undefined;
let disposeIpc: (() => void) | undefined;
let startup: Promise<void> | undefined;
let quitting = false;

function actionFailed(): void {
  if (!quitting) dialog.showErrorBox("Desktop action failed", "Unable to complete this action. Please try again.");
}
function run(action: () => Promise<unknown>): void {
  void action().catch(actionFailed);
}

async function initialize(): Promise<void> {
  const development = !app.isPackaged && typeof CONTROL_WINDOW_VITE_DEV_SERVER_URL === "string";
  const controlUrl = development ? CONTROL_WINDOW_VITE_DEV_SERVER_URL! :
    pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  controller = new DesktopController({
    store: new SettingsStore(app.getPath("userData"), { allowInsecureLoopback: development }),
    controlUrl,
    createControlWindow: () => createControlWindow({ preloadPath: join(__dirname, "preload.cjs") }),
    createRemoteWindow: (origin) => createRemoteWindow({ allowedOrigin: origin }),
    checkServer,
    loginItem: app,
    platform: process.platform,
    quit: () => app.quit(),
    allowInsecureLoopback: development,
  });
  if (quitting) { controller.prepareQuit(); return; }
  const ownedController = controller;
  disposeIpc = registerDesktopIpc({
    ipcMain,
    bridge: ownedController,
    isTrustedSender: (event) => ownedController.isTrustedSender(event),
    allowInsecureLoopback: development,
  });
  await ownedController.start();
  if (quitting) return;
  // Forge packages the Vite output; inline this tiny public PNG with the main bundle.
  const image = nativeImage.createFromDataURL(trayImageData);
  image.setTemplateImage(process.platform === "darwin");
  const ownedTray = new Tray(image);
  tray = ownedTray;
  ownedTray.setToolTip("Personal Intelligence Hub");
  const showMenu = () => run(async () => {
    const state = await ownedController.readState();
    if (quitting) return;
    ownedTray.popUpContextMenu(Menu.buildFromTemplate(buildTrayMenu(state, {
      open: () => run(() => ownedController.open()),
      retry: () => run(() => ownedController.retry()),
      openSettings: () => run(() => ownedController.openSettings()),
      setLaunchAtLogin: (enabled) => run(() => ownedController.setLaunchAtLogin(enabled)),
      quit: () => ownedController.quit(),
    })));
  });
  ownedTray.on("click", showMenu);
  ownedTray.on("right-click", showMenu);
}
function start(): Promise<void> {
  startup ??= initialize();
  return startup;
}

wireApplicationLifecycle(app, {
  start,
  open: async () => { await app.whenReady(); await start(); await controller?.open(); },
  prepareQuit: () => {
    quitting = true;
    controller?.prepareQuit();
    disposeIpc?.();
    disposeIpc = undefined;
    tray?.destroy();
    tray = undefined;
  },
}, () => { actionFailed(); app.quit(); });
