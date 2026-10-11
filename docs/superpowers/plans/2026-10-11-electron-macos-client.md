# Personal Intelligence Hub macOS Desktop Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, open-source Electron client that opens a user-configured private Personal Intelligence Hub server as a macOS desktop and menu-bar application.

**Architecture:** Add `apps/desktop` as a pnpm workspace using Electron 44.7.0, Electron Forge 8.0.1, and Vite 8.3.4. A packaged local control window owns setup, offline recovery, and settings through a narrow preload; a separate sandboxed remote window loads only the validated HTTPS server origin and receives no preload, Node API, or IPC bridge.

**Tech Stack:** Node.js 22, pnpm 9.15.9, TypeScript 5.9.3, Electron 44.7.0, Electron Forge 8.0.1, Vite 8.3.4, Vitest 5.0.1, macOS Apple Silicon.

**Spec:** `docs/superpowers/specs/2026-10-11-electron-macos-client-design.md`

## Global Constraints

- The server remains the only source of truth; do not cache personal records or add offline product behavior.
- Accept remote servers over HTTPS only. Permit HTTP only for loopback hosts in development mode.
- Store only the normalized server origin and desktop preferences; never store passwords, tokens, API keys, or application records.
- The remote window has `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, no preload, and no IPC bridge.
- Compare parsed URL origins exactly; never authorize navigation with prefix matching.
- Deny remote permission requests and new windows by default. Confirm an external HTTPS destination before opening it in the system browser.
- Target Apple Silicon macOS only for packaging. Do not add signing, notarization, automatic updates, Windows, Linux, Intel macOS, or Mac App Store work.
- Keep all examples generic. Do not commit a personal server URL, hostname, account, credential, or production-only default.
- Use TDD for every behavioral unit and keep the existing lint, typecheck, test, build, secret-history, and public-boundary gates green.

## File Map

```text
apps/desktop/
  assets/
    icon.icns                       # macOS application icon derived from the existing public favicon
    tray-template.png               # monochrome macOS template icon
  src/
    main/
      connectivity.ts               # /health probe with timeout and redirect rejection
      controller.ts                 # coordinates settings, control window, and remote window
      external-links.ts             # confirmation and safe system-browser opening
      ipc.ts                        # sender-validated local IPC handlers
      lifecycle.ts                  # tray, close-to-hide, quit, and launch-at-login
      remote-policy.ts              # exact-origin navigation and permission policy
      server-origin.ts              # URL parsing and normalization
      settings-store.ts             # atomic non-secret JSON preferences
      windows.ts                    # creates local and remote BrowserWindows
    renderer/
      index.html                    # packaged local control surface
      renderer.ts                   # setup/offline/settings state machine
      styles.css                    # local desktop control UI
    shared/
      contracts.ts                  # IPC payload/result types and channel names
    forge-env.d.ts                  # Forge Vite compile-time globals
    main.ts                         # Electron entry point
    preload.ts                      # narrow local-window context bridge
  forge.config.ts                   # Electron Forge packaging and Apple Silicon DMG maker
  package.json
  tsconfig.json
  vite.main.config.ts
  vite.preload.config.ts
  vite.renderer.config.ts
  src/**/*.test.ts                  # focused Vitest unit tests beside each module
docs/
  desktop.md                        # public local-build and configuration guide
scripts/
  public-boundary.test.ts           # reject desktop artifacts and personal configuration
```

---

### Task 1: Scaffold the desktop workspace and server-origin boundary

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/shared/contracts.ts`
- Create: `apps/desktop/src/main/server-origin.ts`
- Create: `apps/desktop/src/main/server-origin.test.ts`
- Create: `apps/desktop/vite.main.config.ts`
- Create: `apps/desktop/vite.preload.config.ts`
- Create: `apps/desktop/vite.renderer.config.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `normalizeServerOrigin(input: string, options: { allowInsecureLoopback: boolean }): URL`.
- Produces: `DesktopSettings`, `ConnectionState`, `DesktopBridge`, and exact IPC channel constants.
- Preserves: Node.js 22, pnpm 9.15.9, strict TypeScript, and the existing recursive root scripts.

- [ ] **Step 1: Write URL-boundary tests**

Create table-driven tests that require normalization to an origin and reject credentials, paths other than `/`, query strings, fragments, non-HTTP schemes, and non-loopback HTTP:

```ts
import { describe, expect, it } from "vitest";

import { normalizeServerOrigin } from "./server-origin.js";

describe("normalizeServerOrigin", () => {
  it("normalizes a private HTTPS server to its origin", () => {
    expect(
      normalizeServerOrigin("https://hub.example.test/", {
        allowInsecureLoopback: false,
      }).origin,
    ).toBe("https://hub.example.test");
  });

  it.each([
    "http://hub.example.test",
    "https://user:secret@hub.example.test",
    "https://hub.example.test/private",
    "https://hub.example.test/?debug=1",
    "file:///tmp/index.html",
  ])("rejects unsafe input %s", (input) => {
    expect(() =>
      normalizeServerOrigin(input, { allowInsecureLoopback: false }),
    ).toThrow();
  });

  it("allows HTTP loopback only in development", () => {
    expect(
      normalizeServerOrigin("http://127.0.0.1:3000", {
        allowInsecureLoopback: true,
      }).origin,
    ).toBe("http://127.0.0.1:3000");
  });
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/desktop test -- src/main/server-origin.test.ts`

Expected: FAIL because the desktop workspace and `normalizeServerOrigin` do not exist.

- [ ] **Step 3: Add the workspace with pinned tooling**

Create `apps/desktop/package.json` with:

```json
{
  "name": "@personal-intelligence-hub/desktop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": ".vite/build/main.js",
  "scripts": {
    "build": "electron-forge package",
    "dev": "electron-forge start",
    "make:mac": "electron-forge make --platform=darwin --arch=arm64",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@electron-forge/cli": "8.0.1",
    "@electron-forge/maker-dmg": "8.0.1",
    "@electron-forge/plugin-vite": "8.0.1",
    "electron": "44.7.0",
    "vite": "8.3.4"
  }
}
```

Add root scripts:

```json
{
  "desktop:dev": "pnpm --filter @personal-intelligence-hub/desktop dev",
  "desktop:make": "pnpm --filter @personal-intelligence-hub/desktop make:mac"
}
```

Run: `pnpm install`

Expected: the lockfile records exactly Electron 44.7.0, Forge 8.0.1, and Vite 8.3.4.

Create `apps/desktop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM"],
    "types": ["node", "electron", "vite/client"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "*.config.ts"]
}
```

Use the same explicit external boundary for the main and preload Vite builds:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: { external: ["electron"] },
  },
});
```

Configure `vite.renderer.config.ts` with `root: "src/renderer"`, a restrictive
development CSP, and `build.outDir` outside the renderer source directory. Do
not inject a server URL or environment-derived deployment default into any Vite
configuration.

- [ ] **Step 4: Define shared contracts and implement strict normalization**

Define:

```ts
export type DesktopSettings = Readonly<{
  serverOrigin: string | null;
  launchAtLogin: boolean;
}>;

export type ConnectionState =
  | Readonly<{ kind: "unconfigured" }>
  | Readonly<{ kind: "checking"; origin: string }>
  | Readonly<{ kind: "connected"; origin: string }>
  | Readonly<{ kind: "unavailable"; origin: string; reason: string }>;

export const desktopChannels = {
  readState: "desktop:read-state",
  validateServer: "desktop:validate-server",
  saveServer: "desktop:save-server",
  retry: "desktop:retry",
  setLaunchAtLogin: "desktop:set-launch-at-login",
} as const;
```

Implement `normalizeServerOrigin` with `new URL()`, exact loopback hostname checks for `localhost`, `127.0.0.1`, and `[::1]`, and explicit rejection of credentials, path, search, and hash.

- [ ] **Step 5: Run focused tests, typecheck, and lint**

Run:

```bash
pnpm --filter @personal-intelligence-hub/desktop test -- src/main/server-origin.test.ts
pnpm --filter @personal-intelligence-hub/desktop typecheck
pnpm lint
```

Expected: PASS.

- [ ] **Step 6: Commit the boundary**

```bash
git add package.json pnpm-lock.yaml apps/desktop
git commit -m "feat(desktop): establish secure server origin boundary"
```

---

### Task 2: Add atomic settings and deterministic health checks

**Files:**
- Create: `apps/desktop/src/main/settings-store.ts`
- Create: `apps/desktop/src/main/settings-store.test.ts`
- Create: `apps/desktop/src/main/connectivity.ts`
- Create: `apps/desktop/src/main/connectivity.test.ts`

**Interfaces:**
- Consumes: `DesktopSettings` and `normalizeServerOrigin` from Task 1.
- Produces: `SettingsStore.read(): Promise<DesktopSettings>` and `SettingsStore.write(settings: DesktopSettings): Promise<void>`.
- Produces: `checkServer(origin: URL, dependencies?: { fetch: typeof fetch; timeoutMs: number }): Promise<ConnectionState>`.

- [ ] **Step 1: Write settings-store tests**

Use a temporary directory and assert defaults, valid reads, atomic replacement, mode `0600`, malformed JSON recovery to defaults, and the absence of secret-shaped keys:

```ts
expect(await store.read()).toEqual({
  serverOrigin: null,
  launchAtLogin: false,
});
await store.write({
  serverOrigin: "https://hub.example.test",
  launchAtLogin: true,
});
expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
  serverOrigin: "https://hub.example.test",
  launchAtLogin: true,
});
expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
```

- [ ] **Step 2: Write health-check tests**

Inject `fetch` and assert a successful `{ status: "ok" }` response, timeout, redirect rejection, non-JSON response, wrong payload, and network failure. Error results use stable user-facing reason codes and never echo response bodies.

- [ ] **Step 3: Run both tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/desktop test -- src/main/settings-store.test.ts src/main/connectivity.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement settings persistence**

Write JSON to `settings.json.tmp` with `{ mode: 0o600 }`, rename it over `settings.json`, and chmod the final file to `0o600`. Validate the parsed object and ignore unknown keys. Never accept arbitrary property bags from IPC.

- [ ] **Step 5: Implement the health probe**

Request `new URL("/health", origin)` using:

```ts
await fetch(healthUrl, {
  method: "GET",
  redirect: "error",
  cache: "no-store",
  signal: AbortSignal.timeout(timeoutMs),
  headers: { Accept: "application/json" },
});
```

Require a 2xx status and the exact JSON shape `{ status: "ok" }`. Return `connected` or a sanitized `unavailable` state without response content, host diagnostics, or stack traces.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/desktop test -- src/main/settings-store.test.ts src/main/connectivity.test.ts
pnpm --filter @personal-intelligence-hub/desktop typecheck
```

Expected: PASS.

```bash
git add apps/desktop/src/main
git commit -m "feat(desktop): persist preferences and probe server health"
```

---

### Task 3: Enforce the remote-window security policy

**Files:**
- Create: `apps/desktop/src/main/remote-policy.ts`
- Create: `apps/desktop/src/main/remote-policy.test.ts`
- Create: `apps/desktop/src/main/external-links.ts`
- Create: `apps/desktop/src/main/external-links.test.ts`
- Create: `apps/desktop/src/main/windows.ts`
- Create: `apps/desktop/src/main/windows.test.ts`

**Interfaces:**
- Consumes: a normalized `URL` from Task 1.
- Produces: `isAllowedNavigation(target: string, allowedOrigin: URL): boolean`.
- Produces: `installRemotePolicy(webContents, session, allowedOrigin, confirmExternal): () => void`.
- Produces: `createRemoteWindow(options: RemoteWindowOptions): BrowserWindow` with no preload.

- [ ] **Step 1: Write policy tests**

Require exact-origin acceptance and reject prefix attacks, alternate ports, insecure schemes, credentials, malformed URLs, and cross-origin redirects:

```ts
expect(
  isAllowedNavigation("https://hub.example.test/second-brain", allowed),
).toBe(true);
expect(
  isAllowedNavigation("https://hub.example.test.attacker.invalid", allowed),
).toBe(false);
expect(
  isAllowedNavigation("https://hub.example.test:444/", allowed),
).toBe(false);
```

Mock Electron web contents and session objects to assert:

- cross-origin `will-navigate` is prevented;
- every `setWindowOpenHandler` request returns `{ action: "deny" }`;
- permission checks and requests return false;
- `will-download` is prevented;
- only an HTTPS external destination reaches the confirmation dependency.

- [ ] **Step 2: Write remote-window preference tests**

Capture the `BrowserWindow` constructor options and assert this exact security posture:

```ts
expect(options.webPreferences).toMatchObject({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
});
expect(options.webPreferences).not.toHaveProperty("preload");
```

- [ ] **Step 3: Run tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/desktop test -- src/main/remote-policy.test.ts src/main/external-links.test.ts src/main/windows.test.ts`

- [ ] **Step 4: Implement exact-origin enforcement**

Parse every candidate with `new URL(target)` and compare `.origin` with `allowedOrigin.origin`. Install handlers before `loadURL()`. Remove handlers during window teardown to avoid duplicate listeners after reconnects.

- [ ] **Step 5: Implement external-link confirmation**

The remote window always denies the new window. For user-initiated HTTPS links outside the configured origin, call a dependency that displays the destination hostname and offers Cancel/Open. Invoke `shell.openExternal()` only after the explicit Open result. Reject non-HTTPS destinations before showing a dialog.

- [ ] **Step 6: Implement isolated window creation and commit**

The local control window has the packaged preload and the same sandbox settings. The remote window has no preload. Neither window disables `webSecurity` or accepts invalid certificates.

Run:

```bash
pnpm --filter @personal-intelligence-hub/desktop test -- src/main/remote-policy.test.ts src/main/external-links.test.ts src/main/windows.test.ts
pnpm --filter @personal-intelligence-hub/desktop typecheck
```

Expected: PASS.

```bash
git add apps/desktop/src/main
git commit -m "feat(desktop): isolate remote content from native privileges"
```

---

### Task 4: Build the local control surface and sender-validated IPC

**Files:**
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/main/ipc.ts`
- Create: `apps/desktop/src/main/ipc.test.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/renderer.ts`
- Create: `apps/desktop/src/renderer/renderer.test.ts`
- Create: `apps/desktop/src/renderer/styles.css`
- Create: `apps/desktop/src/forge-env.d.ts`

**Interfaces:**
- Consumes: settings, URL validation, connectivity, and window-controller callbacks from Tasks 1–3.
- Produces: `window.desktop` implementing only `DesktopBridge`.
- Produces: `registerDesktopIpc(options): () => void`, where every handler rejects senders other than the packaged control window.
- Produces: local views `setup`, `checking`, `unavailable`, and `settings`.

- [ ] **Step 1: Write IPC authorization tests**

Inject an `isTrustedSender(event)` function and assert that every channel rejects a remote-window sender before parsing payloads or touching settings. Assert that `saveServer` accepts only `{ serverUrl: string }` and `setLaunchAtLogin` accepts only `{ enabled: boolean }`.

- [ ] **Step 2: Write renderer-state tests**

Using jsdom, assert:

- first launch shows the server form and no sample data;
- validation failure leaves settings unchanged and shows a concise error;
- unavailable state shows Retry and Server settings;
- successful save asks the main process to open the remote app;
- launch-at-login renders the actual reported value and any unsupported state.

- [ ] **Step 3: Run focused tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/desktop test -- src/main/ipc.test.ts src/renderer/renderer.test.ts`

- [ ] **Step 4: Implement the narrow preload**

Expose one frozen object with methods mapped to the exact channel constants:

```ts
contextBridge.exposeInMainWorld("desktop", Object.freeze({
  readState: () => ipcRenderer.invoke(desktopChannels.readState),
  validateServer: (serverUrl: string) =>
    ipcRenderer.invoke(desktopChannels.validateServer, { serverUrl }),
  saveServer: (serverUrl: string) =>
    ipcRenderer.invoke(desktopChannels.saveServer, { serverUrl }),
  retry: () => ipcRenderer.invoke(desktopChannels.retry),
  setLaunchAtLogin: (enabled: boolean) =>
    ipcRenderer.invoke(desktopChannels.setLaunchAtLogin, { enabled }),
} satisfies DesktopBridge));
```

Do not expose `ipcRenderer`, filesystem methods, generic invoke/send methods, or shell access.

- [ ] **Step 5: Implement local setup and recovery UI**

Use semantic HTML, visible focus, reduced-motion support, and the existing Personal Intelligence Hub visual tokens. The local renderer may show connection and configuration state only; it must not contain sample priorities, agents, notes, health values, or cached server content.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/desktop test -- src/main/ipc.test.ts src/renderer/renderer.test.ts
pnpm --filter @personal-intelligence-hub/desktop typecheck
pnpm lint
```

Expected: PASS.

```bash
git add apps/desktop/src
git commit -m "feat(desktop): add local setup and recovery controls"
```

---

### Task 5: Add application lifecycle, tray, and launch-at-login state

**Files:**
- Create: `apps/desktop/src/main/controller.ts`
- Create: `apps/desktop/src/main/controller.test.ts`
- Create: `apps/desktop/src/main/lifecycle.ts`
- Create: `apps/desktop/src/main/lifecycle.test.ts`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/assets/tray-template.png`
- Create: `apps/desktop/assets/icon.icns`

**Interfaces:**
- Consumes: `SettingsStore`, `checkServer`, `createRemoteWindow`, `createControlWindow`, and `registerDesktopIpc`.
- Produces: `DesktopController.start()`, `.open()`, `.retry()`, `.openSettings()`, `.setLaunchAtLogin(enabled)`, and `.quit()`.
- Produces: tray actions Open, Reconnect, Server settings, Launch at login, and Quit.

- [ ] **Step 1: Write controller tests**

Assert these state transitions with injected window and connectivity dependencies:

```text
unconfigured -> local setup
configured + healthy -> remote window
configured + unavailable -> local recovery
retry + healthy -> remote window
change server -> local settings -> validate -> remote window
remote load failure -> local recovery
```

Assert that closing the remote window hides it, an explicit Quit terminates the app, and activating the app reopens the appropriate window.

- [ ] **Step 2: Write tray and login-item tests**

Mock `app.getLoginItemSettings()` and `app.setLoginItemSettings()` to verify:

- the checkbox reflects the value macOS reports;
- toggling calls the OS API and then reads it back;
- failure or mismatch returns an `unsupported` result instead of claiming success;
- settings persist the requested preference but display the actual OS state.

- [ ] **Step 3: Run tests and observe RED**

Run: `pnpm --filter @personal-intelligence-hub/desktop test -- src/main/controller.test.ts src/main/lifecycle.test.ts`

- [ ] **Step 4: Implement the controller and lifecycle**

Set `app.setAppUserModelId("org.personal-intelligence-hub.desktop")`, enforce a single application instance, and wire `second-instance` and `activate` to `controller.open()`. Build the tray menu from current state each time it opens. Mark the tray image as a template image on macOS.

- [ ] **Step 5: Add brand assets without private metadata**

Derive both desktop assets from `apps/web/public/favicon.svg`. Strip creator, filesystem, and timestamp metadata before committing. Verify:

```bash
file apps/desktop/assets/icon.icns apps/desktop/assets/tray-template.png
pnpm verify:secrets
pnpm test:public-boundary
```

Expected: valid ICNS and PNG files; no private strings.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm --filter @personal-intelligence-hub/desktop test
pnpm --filter @personal-intelligence-hub/desktop typecheck
pnpm lint
```

Expected: PASS.

```bash
git add apps/desktop
git commit -m "feat(desktop): add macOS lifecycle and menu bar controls"
```

---

### Task 6: Package the unsigned Apple Silicon application

**Files:**
- Create: `apps/desktop/forge.config.ts`
- Modify: `apps/desktop/package.json`
- Modify: `.gitignore`
- Modify: `scripts/public-boundary.test.ts`
- Test: `apps/desktop/src/packaging.test.ts`

**Interfaces:**
- Consumes: desktop entry points and brand assets from Tasks 1–5.
- Produces: `pnpm desktop:make`, generating an unsigned Apple Silicon `.dmg` under ignored `apps/desktop/out/`.

- [ ] **Step 1: Write packaging-policy tests**

Import the Forge config and assert:

- ASAR packaging is enabled;
- the application name and bundle identifier are generic;
- the DMG maker targets `darwin/arm64` only;
- no signing, notarization, updater, publish target, URL, or credential field exists;
- only local source/assets are packaged.

Extend `scripts/public-boundary.test.ts` so untracked or tracked `.dmg`, `.app`, `.icns` outside the approved desktop asset, `apps/desktop/out/`, desktop `settings.json`, and host-specific desktop configuration fail the boundary test.

- [ ] **Step 2: Run tests and observe RED**

Run:

```bash
pnpm --filter @personal-intelligence-hub/desktop test -- src/packaging.test.ts
pnpm test:public-boundary
```

- [ ] **Step 3: Configure Electron Forge**

Use:

```ts
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "Personal Intelligence Hub",
    executableName: "personal-intelligence-hub",
    appBundleId: "org.personal-intelligence-hub.desktop",
    icon: "assets/icon",
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: { format: "ULFO", name: "Personal Intelligence Hub" },
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        build: [
          { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
          { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
        ],
        renderer: [
          { name: "control_window", config: "vite.renderer.config.ts" },
        ],
      },
    },
  ],
};
```

Set the make command to `electron-forge make --platform=darwin --arch=arm64`. Do not configure `osxSign`, `osxNotarize`, publishers, or auto-updaters.

- [ ] **Step 4: Verify the cross-platform build path**

Run on the development host:

```bash
pnpm --filter @personal-intelligence-hub/desktop test
pnpm --filter @personal-intelligence-hub/desktop typecheck
pnpm --filter @personal-intelligence-hub/desktop build
```

Expected: tests, typecheck, and Forge package pass without creating a distributable or publishing anything.

- [ ] **Step 5: Commit packaging policy**

```bash
git add apps/desktop .gitignore scripts/public-boundary.test.ts package.json pnpm-lock.yaml
git commit -m "build(desktop): package unsigned Apple Silicon app"
```

---

### Task 7: Document local builds and integrate repository verification

**Files:**
- Create: `docs/desktop.md`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/ci-policy.test.ts`

**Interfaces:**
- Consumes: root desktop scripts and security behavior from Tasks 1–6.
- Produces: public instructions for fork owners and CI coverage for desktop source on Ubuntu without attempting macOS packaging.

- [ ] **Step 1: Write CI policy assertions**

Require the existing Ubuntu verification job to install frozen dependencies and run recursive lint, typecheck, test, and build, which now include `apps/desktop`. Assert that no CI step runs `desktop:make`, publishes artifacts, or references Apple credentials.

- [ ] **Step 2: Run the policy test and observe RED**

Run: `pnpm test:ci-policy`

- [ ] **Step 3: Add public desktop documentation**

Document:

1. Requirements: Apple Silicon Mac, Node.js 22, pnpm 9.15.9, and access to a private HTTPS Personal Intelligence Hub server.
2. Development: `pnpm install`, `pnpm desktop:dev`, enter the server URL, and verify `/health`.
3. Local build: `pnpm desktop:make`, open the ignored output folder, and install the unsigned DMG locally.
4. Security: remote content has no native bridge; the app stores only origin and preferences.
5. Limitations: no offline data, auto-update, public binary, signing, notarization, or guaranteed launch-at-login behavior.
6. Privacy: never place a real server URL, credential, or exported settings file in the repository.

Link the guide from `README.md` without adding deployment-specific examples.

- [ ] **Step 4: Keep CI platform-correct**

Let the existing Ubuntu job run desktop unit tests, TypeScript checks, lint, and Vite/Forge source build through recursive scripts. Do not run `make:mac` on Ubuntu. Add an explanatory CI policy assertion rather than a macOS runner in this phase.

- [ ] **Step 5: Run repository gates and commit**

Run:

```bash
pnpm verify:secrets
pnpm test:public-boundary
pnpm test:ci-policy
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: PASS.

```bash
git add README.md docs/desktop.md .github/workflows/ci.yml scripts/ci-policy.test.ts
git commit -m "docs(desktop): add reproducible local macOS workflow"
```

---

### Task 8: Perform macOS packaging and end-to-end acceptance

**Files:**
- Modify only defects found during acceptance.
- Do not commit: `apps/desktop/out/`, local settings, screenshots, logs, `.app`, or `.dmg` artifacts.

**Interfaces:**
- Consumes: the complete desktop workspace and a clean macOS checkout.
- Produces: an installed local application verified against a private HTTPS deployment, with no deployment details committed.

- [ ] **Step 1: Run all source checks in a clean macOS checkout**

Run:

```bash
pnpm install --frozen-lockfile
pnpm verify:secrets:history
pnpm test:public-boundary
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: PASS with a clean Git status.

- [ ] **Step 2: Build the local Apple Silicon DMG**

Run: `pnpm desktop:make`

Expected: Forge creates one unsigned Apple Silicon DMG under `apps/desktop/out/`; Git still reports no unignored artifact.

- [ ] **Step 3: Install and complete first-run setup**

Install the generated app locally. Enter the private HTTPS server URL manually in the setup window. Verify the URL is absent from the source tree, Git diff, build configuration, and packaged resource text.

- [ ] **Step 4: Verify functional flows**

Verify:

- initial health check opens the deployed Personal Intelligence Hub UI;
- authentication and cookies behave like the web app;
- internal navigation remains in the desktop window;
- a cross-origin link is denied until its destination is confirmed, then opens in the default browser;
- disconnecting the private network produces the local recovery view without sample data;
- reconnecting and pressing Retry restores the remote window;
- changing the server returns to validation before loading;
- closing the window leaves the menu bar item, Open restores it, and Quit terminates it.

- [ ] **Step 5: Verify native isolation**

In the remote page DevTools, assert:

```js
typeof window.require === "undefined"
typeof window.process === "undefined"
typeof window.desktop === "undefined"
```

Attempt a non-HTTPS navigation, alternate port, permission request, new window, and download with the fixture server. Expected: each is blocked according to policy.

- [ ] **Step 6: Verify launch at login honestly**

Enable Launch at login, confirm the UI reflects `app.getLoginItemSettings()`, restart macOS, and record whether the unsigned build opens. If macOS refuses or loses the setting, preserve the feature's unsupported/mismatch state; do not claim success or add a persistence workaround.

- [ ] **Step 7: Run final security and history checks**

Run:

```bash
pnpm verify:secrets:history
pnpm test:public-boundary
git status --short
```

Expected: no private URL, settings, credentials, build products, or unrelated changes; working tree clean.

- [ ] **Step 8: Commit acceptance fixes, if any**

If acceptance required source fixes, rerun all Task 8 checks and commit only those fixes:

```bash
git add apps/desktop docs/desktop.md README.md
git commit -m "fix(desktop): resolve macOS acceptance findings"
```

If no fixes were required, do not create an empty commit.
