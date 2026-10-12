# macOS desktop client

Personal Intelligence Hub includes a thin Electron client in `apps/desktop`.
It opens your own private server and reuses its web interface. Each fork owner
builds and configures their own local app; this release does not distribute
public binaries.

## Requirements

- An Apple Silicon Mac running macOS. Intel Macs, Windows and Linux clients
  are outside this release.
- Node.js 22 and pnpm 9.15.9 (the repository pins pnpm through Corepack).
- Access to a deployed, private HTTPS Personal Intelligence Hub server. If
  your deployment uses Tailscale, connect the Mac to its private network first.

The app does not start the web server, API, database or agents. Install and
configure those separately using the repository's deployment documentation.

## Develop locally

Run these commands from the repository root on your Mac:

```bash
corepack enable
pnpm install
pnpm desktop:dev
```

Enter your server origin in the local setup window. Use the origin only, with
no credentials, path, query or fragment. Production requires HTTPS. If your
server uses an explicit port, it is part of the allowed origin. Plain HTTP
loopback is permitted only in development.

Before opening the remote interface, the client checks `/health` on that
origin. It expects a successful JSON response containing exactly
`{"status":"ok"}`. Verify that this endpoint is reachable from the Mac and
does not redirect to a login page; the app then uses the server's normal web
authentication. An unavailable server opens a local recovery screen with
retry and server settings actions.

The local setup and preferences window opens at 720 by 700 pixels and supports
resizing down to 480 by 640 pixels. Controls remain visible at the minimum
size. To check renderer layout with the existing web test tools, run
`pnpm --filter @personal-intelligence-hub/desktop test:layout`. This uses an
installed Chrome when available; otherwise install Playwright's Chromium
through the web workspace first.

## Build and install your local app

Start from a clean checkout on the Apple Silicon Mac:

```bash
pnpm install --frozen-lockfile
pnpm verify:secrets
pnpm test:public-boundary
pnpm test:ci-policy
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm desktop:make
open apps/desktop/out/make
```

Electron Forge creates an unsigned Apple Silicon DMG inside
`apps/desktop/out/make`. Open the DMG, copy the app into your Applications
folder, and launch it. Configure your private server in the app rather than
adding its address to source or build configuration. This output directory is
ignored by Git; do not commit or upload its contents.

macOS may block the unsigned app. For a build you made and trust, use macOS's
per-app approval in System Settings > Privacy & Security if offered. Do not
disable Gatekeeper globally. Packaging a macOS installer must run on macOS;
Ubuntu CI verifies source and produces only a host-platform package as part
of the workspace build.

## Use the app

The menu bar provides Open, Reconnect, Server settings, Launch at login and
Quit. Closing the remote window hides it and leaves the menu bar available;
Quit terminates the application. Server changes repeat URL validation and
the health check. The launch-at-login preference displays the state reported
by macOS, because an unsigned build may not register a reliable login item.

## Security and local storage

Remote web content runs in a sandboxed, context-isolated window with no Node.js
integration, preload or native bridge. The packaged setup screen has a narrow
bridge whose requests are validated separately. Remote navigation is limited
to the exact configured origin; cross-origin navigation, downloads and
permissions are blocked. An external HTTPS new-window request can open in
the system browser only after destination confirmation.

The app's settings store contains only the normalized origin and preferences
in Electron's user-data directory, with atomic writes and restrictive file
permissions. It does not collect passwords, API keys or personal records in
that settings file. Authentication cookies and ordinary Chromium session
storage can persist separately in the remote browser session, so treat the
app's user-data directory as private. This is not an offline data feature.

Never put a real server URL, credential, exported settings file or browser
session in the repository. Do not bake personal defaults into the app or
copy user-data into a build. The repository's secret and public-boundary
checks complement this separation; they cannot recognize every possible
private value. Review your changes before publishing a fork.

## Scope and verification

This version has no offline access, automatic updater, public binary release,
Apple signing or notarization. Launch at login is available as a preference,
with no guarantee for an unsigned app. Web UI changes arrive from your server;
Electron client changes require a new local build.

Ubuntu CI uses frozen dependencies and the repository-wide lint, typecheck,
unit-test and build commands, including desktop source. Its policy tests
reject macOS installer creation, desktop artifact publication and Apple
credentials. CI does not replace testing the installed app on an Apple
Silicon Mac: verify setup, login, navigation, reconnection, menu bar controls,
Quit and the actual login-item behavior for your local build.
