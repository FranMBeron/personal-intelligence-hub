# Personal Intelligence Hub macOS Desktop Client Design

Date: 2026-10-11
Status: Approved for implementation planning

## Summary

Add an open-source macOS desktop client under `apps/desktop`. The client is a
thin Electron shell for a user-configured, private Personal Intelligence Hub
server. It does not run a second backend, cache personal records for offline
use, or fork the existing web interface. The server remains the only source of
truth and the existing Next.js application remains the only product UI.

The first release targets Apple Silicon macOS and is built locally by each
user. Public signed binaries, notarization, automatic updates, Windows, Linux,
and offline operation are outside this version.

## Goals

- Open a private Personal Intelligence Hub server as a normal macOS app.
- Reuse the deployed Next.js UI without duplicating frontend code.
- Let each open-source user configure their own private HTTPS server.
- Provide a menu bar item, a normal application window, reconnection controls,
  and a user-controlled launch-at-login preference.
- Keep remote web content isolated from Electron and operating-system APIs.
- Produce a reproducible local Apple Silicon build from the public repository.

## Non-goals

- Offline access or a local data cache.
- A local copy of the API, database, or background automations.
- Hard-coded deployment URLs, account data, credentials, or personal defaults.
- Public unsigned binary distribution or automatic updates.
- Windows, Linux, Intel macOS, mobile, or Mac App Store support.
- New product screens or divergence from the existing web interface.

## Architecture

The monorepo gains an `apps/desktop` workspace using Electron and Electron
Forge. The desktop package has three deliberately separate surfaces:

1. **Main process** owns application lifecycle, the trusted configuration
   file, connectivity checks, the tray menu, window creation, and the
   launch-at-login request.
2. **Local setup/settings renderer** is packaged with the app. It configures
   and validates the server URL and exposes only narrow, sender-validated IPC
   operations through a context-isolated preload.
3. **Remote application window** loads the configured Personal Intelligence
   Hub HTTPS origin. It has no preload, no Node.js integration, no Electron API,
   and no IPC bridge.

This split prevents a compromised or misconfigured remote page from reaching
desktop privileges. The desktop app stores only the normalized server origin
and user preferences in Electron's user-data directory. Web authentication
continues to use the remote Chromium session and its normal cookies. The app
does not accept or persist passwords, API keys, or application records.

## Onboarding and Configuration

On first launch, the local setup window asks for the Personal Intelligence Hub
server URL. Production URLs must use HTTPS. Plain HTTP is accepted only for
loopback addresses in development builds.

Validation performs all of the following before saving:

- Parse the URL with the platform URL parser and normalize it to an origin.
- Reject embedded credentials, non-HTTPS remote schemes, query strings, and
  fragments.
- Request the existing `/health` endpoint with a short timeout.
- Require a successful response before opening the application window.

Changing the server repeats the same validation. Configuration writes are
atomic and never contain authentication material.

## Application Behavior

The app opens a normal window and also owns a menu bar item. The menu provides:

- Open Personal Intelligence Hub
- Reconnect
- Server settings
- Launch at login
- Quit

Closing the main window hides it while the menu bar process remains available.
Quit explicitly terminates the app. The launch-at-login setting is controlled
by each user and displays the status reported by macOS rather than assuming the
request succeeded.

When the initial health check or page load fails, the remote window is replaced
by a packaged local connection screen. It explains that the private server or
network is unavailable and offers retry and settings actions. No sample or
stale personal data is shown.

## Security Model

The implementation follows Electron's remote-content security guidance:

- Use a current pinned Electron release.
- Enable context isolation, renderer sandboxing, and web security.
- Disable Node.js integration, experimental features, insecure content, and
  all preloads for the remote application window.
- Allow top-level navigation only within the exact configured origin, compared
  with parsed URL origins rather than string prefixes.
- Deny unexpected window creation and permission requests by default.
- Open an external HTTPS link in the system browser only after a user-visible
  confirmation that names its destination host.
- Validate the sender origin for every local IPC operation.
- Apply a restrictive Content Security Policy to packaged local pages.
- Keep Electron APIs completely absent from remote web content.

The remote server is trusted application code, but the desktop client still
treats it as remote content so an XSS or server compromise cannot become native
code execution on the Mac.

References:

- https://www.electronjs.org/docs/latest/tutorial/security/
- https://www.electronjs.org/docs/latest/tutorial/context-isolation
- https://www.electronjs.org/docs/latest/tutorial/sandbox

## Packaging and Distribution

Electron Forge packages an unsigned Apple Silicon `.dmg` from macOS. The root
workspace exposes development, test, package, and make commands that target the
desktop workspace. The public README explains prerequisites, local
configuration, building, installing, and the limitations of unsigned apps.

No downloadable public binary or automatic updater is shipped in this phase.
macOS signing and notarization require Apple Developer Program credentials.
Electron also warns that some operating-system integrations, including login
items, can behave inconsistently without a stable signature. The preference is
therefore implemented and tested on the owner's Mac, but its UI must report the
actual state returned by the operating system.

References:

- https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging
- https://www.electronjs.org/docs/latest/tutorial/code-signing
- https://www.electronforge.io/config/makers

## Testing and Acceptance

Automated tests cover:

- URL normalization and rejection of unsafe inputs.
- Atomic settings persistence without secrets.
- Sender validation for local IPC.
- Remote window preferences and absence of preload/Node access.
- Exact-origin navigation and new-window blocking.
- Permission denial and confirmed external-link handling.
- Health-check success, timeout, disconnect, retry, and server change flows.
- Tray actions and launch-at-login state reporting through mocked Electron APIs.
- Packaging configuration and public-boundary checks.

An integration fixture serves a minimal HTTPS-compatible Personal Intelligence
Hub page so tests do not depend on a personal deployment. Final acceptance on
macOS requires:

1. Build the Apple Silicon app locally.
2. Install it from the generated image.
3. Configure the owner's private HTTPS server without embedding its URL in the
   repository or build artifact.
4. Verify login, navigation, reload, disconnect/reconnect, tray actions, and
   settings.
5. Verify that the remote page has no Node, preload, filesystem, or IPC access.
6. Enable launch at login, restart the Mac, and record the actual result for the
   unsigned build.

## Definition of Done

- `apps/desktop` builds and tests through the existing pnpm workspace.
- The generated local Apple Silicon app opens the deployed web interface over
  its configured private HTTPS origin.
- No personal URL, credentials, records, or production-only configuration are
  committed or packaged.
- All remote-content security tests and existing repository verification gates
  pass.
- The connection screen, settings, tray controls, and launch-at-login status
  behave as specified.
- Public build documentation is sufficient for a fork owner to create their
  own local app.
