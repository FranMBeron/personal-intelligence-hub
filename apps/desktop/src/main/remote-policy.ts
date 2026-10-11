import type { Event, Session, WebContents, WebContentsWillNavigateEventParams, WebContentsWillRedirectEventParams } from "electron";

export type ConfirmExternal = (target: string) => Promise<unknown>;

export function isAllowedNavigation(target: string, allowedOrigin: URL): boolean {
  try {
    const candidate = new URL(target);
    return (candidate.protocol === "https:" || candidate.protocol === "http:") &&
      !candidate.username && !candidate.password &&
      candidate.origin === allowedOrigin.origin;
  } catch {
    return false;
  }
}

type SessionPolicy = { owners: number; denyDownload: (event: Event) => void };
const sessionPolicies = new WeakMap<Session, SessionPolicy>();

export function installRemotePolicy(
  webContents: WebContents,
  session: Session,
  allowedOrigin: URL,
  confirmExternal: ConfirmExternal,
): () => void {
  const origin = new URL(allowedOrigin.href);
  let active = true;
  const blockNavigation = (event: Event<WebContentsWillNavigateEventParams | WebContentsWillRedirectEventParams>) => {
    if (!isAllowedNavigation(event.url, origin)) event.preventDefault();
  };
  webContents.on("will-navigate", blockNavigation);
  webContents.on("will-redirect", blockNavigation);
  webContents.setWindowOpenHandler((details) => {
    if (active && ["foreground-tab", "background-tab", "new-window"].includes(details.disposition)) {
      try {
        const target = new URL(details.url);
        if (target.protocol === "https:" && !target.username && !target.password &&
            target.origin !== origin.origin) {
          // Confirmation never authorizes an Electron child window.
          void Promise.resolve().then(() => {
            if (active) return confirmExternal(target.href);
            return undefined;
          }).catch(() => undefined);
        }
      } catch {
        // Malformed and non-HTTPS destinations stay denied.
      }
    }
    return { action: "deny" };
  });

  let policy = sessionPolicies.get(session);
  if (!policy) {
    const denyDownload = (event: Event) => event.preventDefault();
    policy = { owners: 0, denyDownload };
    sessionPolicies.set(session, policy);
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.on("will-download", denyDownload);
  }
  policy.owners += 1;
  const ownedPolicy = policy;

  return () => {
    if (!active) return;
    active = false;
    webContents.removeListener("will-navigate", blockNavigation);
    webContents.removeListener("will-redirect", blockNavigation);
    if (!webContents.isDestroyed()) {
      webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    }
    ownedPolicy.owners -= 1;
    if (ownedPolicy.owners === 0) {
      session.removeListener("will-download", ownedPolicy.denyDownload);
      session.setPermissionCheckHandler(null);
      session.setPermissionRequestHandler(null);
      sessionPolicies.delete(session);
    }
  };
}
