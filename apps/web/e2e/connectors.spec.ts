import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * User journeys against the fictional connectors stack (e2e/connectors-stack.ts): the production
 * build behind the peer-aware server, reached only through the Tailscale Serve simulator. The
 * fictional connector keeps state across requests and can be told to fail, so these checks see
 * real persistence, replay, conflicts and provider failures rather than a fixture that always succeeds.
 */
const servedOrigin = "http://127.0.0.1:4410";
const control = "http://127.0.0.1:4411/__control";
// The web's own TCP listener: reachable on the host, but it must never yield an identity.
const webTcpOrigin = "http://127.0.0.1:4412";
const tailnetHeaders = { "x-forwarded-for": "100.64.0.10" };

test.use({ baseURL: servedOrigin, extraHTTPHeaders: tailnetHeaders });
test.setTimeout(120_000);

type Faults = Partial<{
  calendar: boolean;
  systemStatus: boolean;
  hermesSend: boolean;
  device: "unavailable" | "connected" | "bridge_down";
}>;

type FixtureState = Readonly<{
  preferences: { timeZone: string; version: number };
  proposals: ReadonlyArray<{ id: string; status: string; version: number; confirmations: number }>;
}>;

const reset = async (request: APIRequestContext, faults: Faults = {}) => {
  const response = await request.post(control, { data: { scenario: "normal", faults } });
  expect(response.ok(), "fixture reset").toBe(true);
};

const setFaults = async (request: APIRequestContext, faults: Faults) => {
  const response = await request.post(control, { data: { faults } });
  expect(response.ok(), "fixture faults").toBe(true);
};

const fixtureState = async (request: APIRequestContext): Promise<FixtureState> => {
  const response = await request.get(`${control}/state`);
  expect(response.ok(), "fixture state").toBe(true);
  return await response.json() as FixtureState;
};

/** Records every browser request that could change server state. */
const recordMutations = (page: Page): string[] => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/api/ui/v1/")) mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return mutations;
};

const centralWorkspace = (page: Page): Locator => page.getByRole("region", { name: "Espacio de conversación de Central" });

const sendMessage = async (workspace: Locator, agentName: string, text: string) => {
  await workspace.getByLabel(`Mensaje para ${agentName}`).fill(text);
  await workspace.getByRole("button", { name: "Enviar" }).click();
};

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("a thread survives reload, profile switches and a fresh browser context", async ({ page, browser, request }) => {
  const message = "Recuérdame revisar el presupuesto ficticio";
  const reply = `Respuesta ficticia: ${message}`;

  await page.goto("/");
  const central = centralWorkspace(page);
  await expect(central.getByRole("button", { name: "Seleccionar Principal" })).toHaveAttribute("aria-pressed", "true");

  // Create an extra thread explicitly, then send into it.
  await central.getByRole("button", { name: "Nueva conversación", exact: true }).click();
  const created = central.getByRole("button", { name: "Seleccionar Nueva conversación" });
  await expect(created).toHaveAttribute("aria-pressed", "true");
  await sendMessage(central, "Central", message);
  const log = central.getByRole("log");
  await expect(log.getByText(message, { exact: true })).toHaveCount(1);
  // The reply arrives over the event stream, after the history snapshot's cursor.
  await expect(log.getByText(reply, { exact: true })).toHaveCount(1, { timeout: 15_000 });

  // Reload: history replays the snapshot and the stream resumes after it; nothing is duplicated.
  await page.reload();
  await expect(centralWorkspace(page).getByRole("button", { name: "Seleccionar Nueva conversación" })).toHaveAttribute("aria-pressed", "true");
  await expect(centralWorkspace(page).getByRole("log").getByText(message, { exact: true })).toHaveCount(1);
  await expect(centralWorkspace(page).getByRole("log").getByText(reply, { exact: true })).toHaveCount(1);

  // Switch to another profile and back: each profile keeps its own server-side selection.
  await page.goto("/agents");
  await page.getByRole("button", { name: /^Conversar con Fitness/u }).click();
  const fitness = page.getByRole("region", { name: "Espacio de conversación de Fitness" });
  await expect(fitness.getByRole("button", { name: "Seleccionar Principal" })).toHaveAttribute("aria-pressed", "true");
  await expect(fitness).not.toContainText(message);
  await page.getByRole("button", { name: /^Conversar con Central/u }).click();
  const centralAgain = centralWorkspace(page);
  await expect(centralAgain.getByRole("button", { name: "Seleccionar Nueva conversación" })).toHaveAttribute("aria-pressed", "true");
  await expect(centralAgain.getByRole("log").getByText(reply, { exact: true })).toHaveCount(1);

  // A new browser context (no cookies, cache or storage) is the restart equivalent.
  const fresh = await browser.newContext({ baseURL: servedOrigin, extraHTTPHeaders: tailnetHeaders });
  try {
    const restarted = await fresh.newPage();
    await restarted.goto("/second-brain");
    const restartedCentral = centralWorkspace(restarted);
    await expect(restartedCentral.getByRole("button", { name: "Seleccionar Nueva conversación" })).toHaveAttribute("aria-pressed", "true");
    await expect(restartedCentral.getByRole("log").getByText(message, { exact: true })).toHaveCount(1);
    await expect(restartedCentral.getByRole("log").getByText(reply, { exact: true })).toHaveCount(1);
  } finally {
    await fresh.close();
  }

  // A reply written elsewhere (for example the desktop app) reaches an open page live.
  await page.goto("/");
  await expect(centralWorkspace(page).getByRole("log").getByText(reply, { exact: true })).toHaveCount(1);
  const pushed = await request.post(`${control}/assistant`, { data: { agentId: "central-fictional", text: "Aviso ficticio desde otro dispositivo" } });
  expect(pushed.ok()).toBe(true);
  await expect(centralWorkspace(page).getByRole("log").getByText("Aviso ficticio desde otro dispositivo", { exact: true })).toHaveCount(1, { timeout: 15_000 });
});

test("a provider failure keeps the draft retryable without duplicating the message", async ({ page, request }) => {
  const message = "Mensaje ficticio que falla primero";
  await setFaults(request, { hermesSend: true });
  await page.goto("/");
  const central = centralWorkspace(page);
  await expect(central.getByRole("button", { name: "Seleccionar Principal" })).toHaveAttribute("aria-pressed", "true");
  await sendMessage(central, "Central", message);
  await expect(central.getByText("Hermes no pudo procesar el mensaje. Inténtalo de nuevo en unos minutos.").first()).toBeVisible();

  await setFaults(request, { hermesSend: false });
  await central.getByRole("button", { name: "Reintentar" }).click();
  await expect(central.getByRole("log").getByText(`Respuesta ficticia: ${message}`, { exact: true })).toHaveCount(1, { timeout: 15_000 });
  await page.reload();
  await expect(centralWorkspace(page).getByRole("log").getByText(message, { exact: true })).toHaveCount(1);
});

test("Central delegations appear only in the ledger, never in direct threads", async ({ page }) => {
  for (const agentId of ["central-fictional", "finance-fictional"]) {
    await page.goto(`/agents?agent=${agentId}`);
    const ledger = page.locator(".delegation-ledger");
    const direct = page.locator(".agent-workspace__direct");
    await expect(ledger.getByText("Revisar gastos ficticios del mes")).toBeVisible();
    await expect(direct.getByRole("region", { name: /^Espacio de conversación de/u })).toBeVisible();
    await expect(direct.getByRole("log")).toBeVisible();
    await expect(direct).not.toContainText("Revisar gastos ficticios del mes");
    await expect(direct).not.toContainText("Resumen ficticio entregado");
    await expect(direct).not.toContainText("Plan de entrenamiento ficticio");
    // Direct threads list only the profile's own conversations.
    await expect(direct.getByRole("button", { name: /^Seleccionar / })).toHaveCount(2);
  }
  await page.goto("/agents?agent=central-fictional");
  await expect(page.locator(".delegation-ledger").getByText("Plan de entrenamiento ficticio")).toBeVisible();
});

test("a Calendar failure keeps priorities and recovers after a refresh", async ({ page, request }) => {
  await setFaults(request, { calendar: true });
  await page.goto("/");
  const priorities = page.getByRole("list", { name: "Prioridades de hoy" });
  await expect(priorities.getByText("Revisar la nota de arquitectura")).toBeVisible();
  await expect(priorities.getByText("Preparar la revisión semanal")).toBeVisible();
  await expect(page.getByText("Agenda no disponible")).toBeVisible();
  await expect(page.getByRole("list", { name: "Eventos de hoy" })).toHaveCount(0);

  await setFaults(request, { calendar: false });
  await page.reload();
  await expect(page.getByRole("list", { name: "Eventos de hoy" }).getByText("Reunión de planificación")).toBeVisible();
  await expect(page.getByRole("list", { name: "Prioridades de hoy" }).getByText("Revisar la nota de arquitectura")).toBeVisible();
});

test("a failed source recovers when Sistema refreshes its status", async ({ page, request }) => {
  await setFaults(request, { systemStatus: true });
  await page.goto("/system");
  const status = page.getByRole("region", { name: "Estado del sistema" });
  const connectors = status.getByRole("article", { name: "Conectores privados" });
  await expect(connectors).toContainText("No disponible");
  await expect(status.getByRole("article", { name: "Hermes" })).toHaveCount(0);

  await setFaults(request, { systemStatus: false });
  await status.getByRole("button", { name: "Actualizar estado" }).click();
  await expect(status.getByRole("article", { name: "Hermes" })).toContainText("Verificado en la última comprobación");
  await expect(status.getByRole("article", { name: "Conectores privados" })).toContainText("El servicio respondió a la consulta de estado.");
  await expect(status.getByRole("article", { name: "Conectores privados" })).not.toContainText("No disponible");
});

const expectedDay = (timeZone: string) =>
  new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone }).format(new Date());

test("changing the time zone shifts the displayed day consistently", async ({ page, request }) => {
  // UTC+14 and UTC−11 are always on different calendar days.
  for (const timeZone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
    await page.goto("/system");
    const form = page.getByRole("form", { name: "Preferencia de zona horaria" });
    await form.getByLabel("Zona horaria").fill(timeZone);
    await form.getByRole("button", { name: "Guardar zona horaria" }).click();
    await expect(form.getByText(`Zona horaria guardada: ${timeZone}.`)).toBeVisible();

    await page.goto("/");
    await expect(page.locator(".hoy-hero__copy .eyebrow")).toHaveText(expectedDay(timeZone));
    // The agenda window is the same local day: a 09:00 local event shows at 09:00 in the new zone.
    const meeting = page.getByRole("list", { name: "Eventos de hoy" }).getByRole("listitem").filter({ hasText: "Reunión de planificación" });
    await expect(meeting).toContainText("09:00 – 10:00");
  }
  expect((await fixtureState(request)).preferences).toEqual({ timeZone: "Pacific/Pago_Pago", version: 3 });
});

test("a time zone changed on another device is reloaded instead of overwritten", async ({ page, request }) => {
  await page.goto("/system");
  const changed = await request.post(`${control}/preferences`, { data: { timeZone: "America/Mexico_City" } });
  expect(changed.ok()).toBe(true);
  const form = page.getByRole("form", { name: "Preferencia de zona horaria" });
  await form.getByLabel("Zona horaria").fill("Asia/Tokyo");
  await form.getByRole("button", { name: "Guardar zona horaria" }).click();
  await expect(form.getByText(/La zona horaria se cambió desde otro dispositivo\. Se cargó el valor guardado \(America\/Mexico_City\)/u)).toBeVisible();
  expect((await fixtureState(request)).preferences.timeZone).toBe("America/Mexico_City");
});

test("an approval deep link never mutates before an explicit confirmation", async ({ page, request }) => {
  const mutations = recordMutations(page);
  await page.goto("/system?proposal=opaque-proposal-7f3");
  const review = page.getByRole("region", { name: "Revisar propuesta: Crear evento" });
  await expect(review.getByRole("list", { name: "Invitados (2)" })).toContainText("persona@example.test");
  await expect(review.getByRole("list", { name: "Invitados (2)" })).toContainText("otra.persona@example.test");
  await expect(review.getByText("Notas ficticias de la reunión. Segunda línea con el orden del día completo.")).toBeVisible();
  await expect(review.getByText("Revisión del plan")).toBeVisible();
  await page.waitForTimeout(500);
  expect(mutations).toEqual([]);
  expect((await fixtureState(request)).proposals).toContainEqual({ id: "opaque-proposal-7f3", status: "pending", version: 0, confirmations: 0 });

  await review.getByRole("button", { name: "Confirmar cambio" }).click();
  await expect(review.getByRole("heading", { name: "Cambio aplicado" })).toBeVisible({ timeout: 15_000 });
  expect(mutations).toEqual(["POST /api/ui/v1/calendar/change-proposals/opaque-proposal-7f3/confirmation"]);
  expect((await fixtureState(request)).proposals).toContainEqual({ id: "opaque-proposal-7f3", status: "completed", version: 1, confirmations: 1 });
});

test("device reconnect reports Conectada only when the bridge confirms it", async ({ page, request }) => {
  await setFaults(request, { device: "unavailable" });
  await page.goto("/system");
  const device = page.getByRole("region", { name: "Conexión del dispositivo" });
  await expect(device).toContainText("No disponible");

  await device.getByRole("button", { name: "Reconectar" }).click();
  await expect(device.getByRole("button", { name: "Reconectando…" })).toBeDisabled();
  await expect(device.getByRole("alert")).toHaveText(/Despierta el dispositivo/u);
  await expect(device).not.toContainText("Conectada");

  await setFaults(request, { device: "bridge_down" });
  await device.getByRole("button", { name: "Reconectar" }).click();
  await expect(device.getByRole("alert")).toHaveText("No se pudo contactar con el puente del dispositivo. Vuelve a intentarlo más tarde.");
  await expect(device).not.toContainText("Conectada");

  await setFaults(request, { device: "connected" });
  await device.getByRole("button", { name: "Reconectar" }).click();
  await expect(device.getByRole("button", { name: "Reconectando…" })).toBeVisible();
  await expect(device.getByRole("status")).toHaveText("Conexión confirmada por el puente del dispositivo.");
  await expect(device).toContainText("Conectada");
});

test("identity headers sent straight to the web's TCP port are rejected", async ({ playwright }) => {
  const forged = await playwright.request.newContext({
    extraHTTPHeaders: {
      "x-forwarded-for": "100.64.0.10",
      "tailscale-user-login": "owner@example.test",
      "tailscale-user-name": "Owner Example",
    },
  });
  try {
    for (const path of ["/api/ui/v1/agents", "/api/ui/v1/preferences", "/api/ui/v1/conversations?agentId=central-fictional"]) {
      const response = await forged.get(`${webTcpOrigin}${path}`);
      expect(response.status(), `${path} over TCP`).toBe(401);
      expect(await response.text()).not.toContain("central-fictional");
    }
    const mutation = await forged.patch(`${webTcpOrigin}/api/ui/v1/preferences`, { data: { timeZone: "Asia/Tokyo", expectedVersion: 1 } });
    expect(mutation.status()).toBeGreaterThanOrEqual(400);
    expect((await fixtureState(forged)).preferences.timeZone).toBe("Europe/Madrid");
  } finally {
    await forged.dispose();
  }
  // The same request through the Serve simulator (the private proxy socket) is authenticated.
  const served = await playwright.request.newContext({ extraHTTPHeaders: tailnetHeaders });
  try {
    expect((await served.get(`${servedOrigin}/api/ui/v1/agents`)).status()).toBe(200);
  } finally {
    await served.dispose();
  }
});
