import type { ConnectionState, DesktopBridge, DesktopState } from "../shared/contracts.js";

type View = "setup" | "checking" | "unavailable" | "settings";

const mountedSurfaces = new WeakMap<HTMLElement, () => void>();

// Text from main-process state is always inserted as text, never markup.
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export async function mountControlSurface(
  root: HTMLElement,
  bridge: DesktopBridge,
  options: { view?: "settings" } = {},
): Promise<void> {
  mountedSurfaces.get(root)?.();
  let active = true;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let readEpoch = 0;
  const isMounted = () => active && root.isConnected;
  function cancelPoll() {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
    readEpoch += 1;
  }
  mountedSurfaces.set(root, () => { active = false; cancelPoll(); });

  let state: DesktopState;
  let view: View;
  let draft = "";
  let pendingServer: string | null = null;
  let busy = false;
  let error = "";
  let invalidServer = false;
  let status = "";

  function action(label: string, run: () => void, className = "button button--quiet") {
    const control = element("button", label, className);
    control.type = "button";
    control.addEventListener("click", run);
    return control;
  }

  function setBusy(message: string) {
    cancelPoll();
    busy = true;
    root.dataset.view = "checking";
    root.setAttribute("aria-busy", "true");
    for (const control of Array.from(root.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"))) control.disabled = true;
    const live = root.querySelector<HTMLElement>("[role=status]");
    if (live) live.textContent = message;
  }

  function finishConnection(connection: ConnectionState, opening: boolean) {
    if (!isMounted()) return;
    busy = false;
    state = { ...state, connection };
    if (connection.kind === "connected") {
      pendingServer = null;
      view = "settings";
      status = opening ? "Opening your Hub…" : "Connected to your server.";
    } else if (connection.kind === "unconfigured") {
      view = "setup";
      status = "";
    } else {
      view = connection.kind === "checking" ? "checking" : "unavailable";
      status = "";
    }
    render();
  }

  async function connect(serverUrl: string) {
    if (busy || !isMounted()) return;
    error = "";
    invalidServer = false;
    draft = serverUrl;
    const previousView = state.settings.serverOrigin ? "settings" : "setup";
    setBusy("Checking your server…");
    let validation: ConnectionState;
    try {
      validation = await bridge.validateServer(serverUrl);
      if (!isMounted()) return;
    } catch {
      if (!isMounted()) return;
      busy = false;
      view = previousView;
      invalidServer = true;
      error = "Use an HTTPS server origin without credentials, a path, query, or fragment.";
      render();
      root.querySelector<HTMLInputElement>("#server-url")?.focus();
      return;
    }
    if (validation.kind !== "connected") {
      pendingServer = serverUrl;
      finishConnection(validation, false);
      return;
    }
    try {
      // Saving is the narrow main-process request that persists and opens the remote app.
      const connection = await bridge.saveServer(validation.origin);
      if (!isMounted()) return;
      if (connection.kind === "connected") {
        state = { ...state, settings: { ...state.settings, serverOrigin: connection.origin } };
        draft = connection.origin;
      } else {
        pendingServer = serverUrl;
      }
      finishConnection(connection, true);
    } catch {
      if (!isMounted()) return;
      busy = false;
      view = previousView;
      error = "Unable to save server settings. Please try again.";
      render();
    }
  }

  async function retry() {
    if (busy || !isMounted()) return;
    if (pendingServer) { await connect(pendingServer); return; }
    error = "";
    setBusy("Checking your server…");
    try {
      finishConnection(await bridge.retry(), true);
    } catch {
      if (!isMounted()) return;
      busy = false;
      view = "unavailable";
      error = "Unable to reconnect. Please try again.";
      render();
    }
  }

  async function setLogin(enabled: boolean, control: HTMLInputElement) {
    if (busy || !isMounted()) return;
    error = "";
    invalidServer = false;
    const hadFocus = document.activeElement === control;
    setBusy("Updating launch at login…");
    try {
      const launchAtLogin = await bridge.setLaunchAtLogin(enabled);
      if (!isMounted()) return;
      state = { ...state, launchAtLogin, settings: { ...state.settings, launchAtLogin: launchAtLogin.requested } };
    } catch {
      if (!isMounted()) return;
      error = "Unable to update launch at login. Please try again.";
    }
    busy = false;
    const restoreFocus = hadFocus && (document.activeElement === control || document.activeElement === document.body);
    render();
    if (restoreFocus) {
      const replacement = root.querySelector<HTMLInputElement>("#launch-at-login");
      if (replacement?.disabled) root.querySelector<HTMLElement>("#login-status")?.focus();
      else replacement?.focus();
    }
  }

  function render() {
    if (!isMounted()) return;
    cancelPoll();
    root.replaceChildren();
    root.dataset.view = view;
    root.setAttribute("aria-busy", view === "checking" ? "true" : "false");
    const heading = view === "setup" ? "Connect your Hub" : view === "unavailable" ? "Server unavailable" :
      view === "checking" ? "Checking your server" : "Server settings";
    root.append(element("p", "Your private workspace", "eyebrow"), element("h1", heading));
    const live = element("p", status, "connection-status");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    if (view === "checking") live.textContent = "Checking your server…";
    root.append(live);
    if (view === "unavailable") {
      root.append(element("p", "Your server or network could not be reached. Check your connection, then try again.", "description"));
      if (state.connection.kind !== "unconfigured") root.append(element("p", state.connection.origin, "server-origin"));
      const actions = element("div", undefined, "actions");
      actions.append(action("Retry", () => { void retry(); }, "button"), action("Server settings", () => {
        view = state.settings.serverOrigin ? "settings" : "setup";
        error = "";
        render();
      }));
      root.append(actions);
    } else if (view !== "checking") {
      root.append(element("p", "Enter the HTTPS address of your Personal Intelligence Hub server.", "description"));
      const form = element("form");
      const label = element("label", "Server URL");
      label.htmlFor = "server-url";
      const input = element("input");
      input.id = "server-url";
      input.name = "serverUrl";
      input.type = "url";
      input.required = true;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.value = draft;
      input.addEventListener("input", () => { draft = input.value; });
      input.setAttribute("aria-describedby", invalidServer ? "server-hint control-error" : "server-hint");
      input.setAttribute("aria-invalid", invalidServer ? "true" : "false");
      const hint = element("p", "Use only the server origin, without a path or sign-in details.", "hint");
      hint.id = "server-hint";
      const save = element("button", "Connect to Hub", "button");
      save.type = "submit";
      form.append(label, input, hint, save);
      form.addEventListener("submit", (event) => { event.preventDefault(); void connect(input.value); });
      root.append(form);
    }
    if (error) {
      const alert = element("p", error, "error");
      alert.id = "control-error";
      alert.setAttribute("role", "alert");
      root.append(alert);
    }
    const login = element("section", undefined, "login-setting");
    login.setAttribute("aria-label", "Desktop preference");
    const label = element("label", undefined, "checkbox-label");
    label.htmlFor = "launch-at-login";
    const checkbox = element("input");
    checkbox.id = "launch-at-login";
    checkbox.type = "checkbox";
    checkbox.checked = state.launchAtLogin.enabled;
    checkbox.disabled = !state.launchAtLogin.supported || view === "checking";
    checkbox.setAttribute("aria-describedby", "login-status");
    checkbox.addEventListener("change", () => { void setLogin(checkbox.checked, checkbox); });
    label.append(checkbox, element("span", "Launch at login"));
    const loginStatus = element("p", state.launchAtLogin.supported ?
      `Currently ${state.launchAtLogin.enabled ? "on" : "off"}, as reported by the operating system.` :
      `Launch at login is unavailable on this system. Currently ${state.launchAtLogin.enabled ? "on" : "off"}.`, "hint");
    loginStatus.id = "login-status";
    loginStatus.tabIndex = -1;
    login.append(label, loginStatus);
    root.append(login);
    // Read serially only while main reports checking; no additional bridge is needed.
    if (view === "checking" && state.connection.kind === "checking" && !busy) {
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        if (!isMounted()) { active = false; cancelPoll(); return; }
        void read();
      }, 500);
    }
  }

  async function read() {
    cancelPoll();
    const epoch = readEpoch;
    try {
      const nextState = await bridge.readState();
      if (!isMounted() || epoch !== readEpoch) return;
      state = nextState;
      draft = state.settings.serverOrigin ?? "";
      view = options.view ?? (state.connection.kind === "unconfigured" ? "setup" : state.connection.kind === "connected" ? "settings" : state.connection.kind);
      render();
    } catch {
      if (!isMounted() || epoch !== readEpoch) return;
      cancelPoll();
      busy = false;
      view = "unavailable";
      root.setAttribute("aria-busy", "false");
      root.replaceChildren(element("h1", "Desktop settings unavailable"));
      root.dataset.view = "unavailable";
      const alert = element("p", "Unable to read desktop settings. Please try again.", "error");
      alert.setAttribute("role", "alert");
      root.append(alert, action("Retry", () => { void read(); }, "button"));
    }
  }
  await read();
}

const root = typeof document === "undefined" ? null : document.getElementById("desktop-root");
if (root && window.desktop) {
  const options = new URLSearchParams(window.location.search).get("view") === "settings" ? { view: "settings" as const } : {};
  void mountControlSurface(root, window.desktop, options);
}
