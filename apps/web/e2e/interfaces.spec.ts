import { expect, test } from "@playwright/test";

const fixtureURL = "http://127.0.0.1:4401";

test.beforeEach(async ({ request }) => {
  await request.post(`${fixtureURL}/__control`, {
    data: { api: "available" },
  });
});

/*
 * The default web server runs without private connectors: Hermes, Calendar and the Central entry
 * must say "not configured" honestly while Second Brain keeps working. Connector-backed journeys
 * run against the fictional connectors stack (port 4410) further below.
 */
test("uses every interface without connectors and never exposes runtime values", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByText("Revisar la nota de arquitectura")).toBeVisible();
  await expect(page.getByText("La conversación central no está configurada")).toBeVisible();
  await expect(page.getByLabel(/Mensaje para/u)).toHaveCount(0);

  await page.getByRole("link", { name: "Agentes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agentes" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Roster de agentes" }).getByText("Hermes no configurado")).toBeVisible();

  await page.getByRole("link", { name: "Second Brain" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Second Brain" })).toBeVisible();
  await page.getByLabel("Buscar").fill("source");
  await page.getByRole("button", { name: "Aplicar" }).click();
  await expect(page).toHaveURL(/\/second-brain\?q=source/u);
  await expect(page.getByText("Source insight")).toBeVisible();
  await expect(page.getByRole("link", { name: "Abrir en Obsidian" })).toHaveAttribute(
    "href",
    "obsidian://open?vault=Notes&file=source",
  );
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);

  await page.getByRole("link", { name: "Sistema" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sistema" })).toBeVisible();
  await expect(page.getByText("Google Calendar no está configurado")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("e2e-fictional-delegated-token");
  await expect(page.locator("body")).not.toContainText("e2e-fictional-service-token");
  expect(consoleErrors).toEqual([]);
});

test("shows verified source-down states", async ({ page, request }) => {
  await request.post(`${fixtureURL}/__control`, {
    data: { api: "unavailable" },
  });

  await page.goto("/");
  await expect(page.getByText("Prioridades no disponibles")).toBeVisible();
  await expect(page.locator(".hoy-operational")).toBeVisible();
  await expect(page.locator(".day-grid")).toBeVisible();
  await page.goto("/system");
  await expect(page.getByRole("region", { name: "API de datos personales" }).getByText("No disponible")).toBeVisible();
  await expect(page.getByRole("region", { name: "Estado del sistema" })).toBeVisible();
});

test("renders the approved shell and page compositions", async ({ page }, testInfo) => {
  const routes = [
    { path: "/", name: "hoy", composition: ".hoy-operational" },
    { path: "/agents", name: "agentes", composition: ".agents-roster__metrics" },
    { path: "/second-brain", name: "second-brain", composition: ".brain-workspace" },
    { path: "/system", name: "sistema", composition: ".system-status" },
  ];

  for (const route of routes) {
    await page.goto(route.path);
    await expect(page.locator(".app-bar")).toBeVisible();
    await expect(page.locator(".app-shell > .app-navigation")).toBeVisible();
    await expect(page.locator(".app-navigation--sidebar")).toHaveCount(0);
    await expect(page.locator(route.composition)).toBeVisible();
    await page.screenshot({
      path: `/tmp/pih-after/${testInfo.project.name}-${route.name}.png`,
      fullPage: true,
    });
  }
});

test("keeps the skip link visually hidden until it receives keyboard focus", async ({ page }) => {
  await page.goto("/");
  const skip = page.getByRole("link", { name: "Saltar al contenido" });
  const viewport = page.viewportSize()!;
  const onScreen = async () => {
    const box = await skip.boundingBox();
    if (box === null) return false;
    return box.y + box.height > 0 && box.y < viewport.height && box.x + box.width > 0 && box.x < viewport.width;
  };
  await expect(skip).not.toBeFocused();
  expect(await onScreen(), "skip link is off screen while unfocused").toBe(false);
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect.poll(async () => {
    const box = await skip.boundingBox();
    return box !== null && box.y >= 0 && box.y + box.height <= viewport.height;
  }, { message: "skip link is fully on screen when focused" }).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect.poll(onScreen, { message: "skip link hides again after focus leaves" }).toBe(false);
});

test("supports keyboard entry, reduced motion, and contained responsive layouts", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Saltar al contenido" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
  ).toBe("auto");

  for (const path of ["/", "/agents", "/second-brain", "/system"]) {
    await page.goto(path);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      `No document overflow on ${path}`,
    ).toBe(true);
  }
});

test.describe("with private connectors", () => {
  test.use({ baseURL: "http://127.0.0.1:4410", extraHTTPHeaders: { "x-forwarded-for": "100.64.0.10" } });

  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:4411/__control", { data: { scenario: "normal" } });
  });

  test("agent filters are real buttons driven by keyboard and history", async ({ page }) => {
    await page.goto("/agents");
    const filters = page.getByRole("group", { name: "Filtrar agentes" });
    const all = filters.getByRole("button", { name: "Todos" });
    const active = filters.getByRole("button", { name: "En actividad" });
    const alerts = filters.getByRole("button", { name: "Con alertas" });
    await expect(all).toHaveAttribute("aria-pressed", "true");

    await all.focus();
    await page.keyboard.press("Tab");
    await expect(active).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(active).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/\/agents\?filter=active$/u);
    await expect(page.getByRole("heading", { name: "Central" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Finanzas" })).toHaveCount(0);

    await page.keyboard.press("Tab");
    await expect(alerts).toBeFocused();
    await page.keyboard.press("Space");
    await expect(alerts).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Finanzas" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Central" })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: /Mostrando 1 de 3 agentes/u })).toHaveCount(1);

    await page.goBack();
    await expect(page).toHaveURL(/\/agents\?filter=active$/u);
    await expect(active).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Finanzas" })).toBeVisible();
  });

  test("a delegation's source link opens the Central thread without changing the selection", async ({ page }) => {
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.url().includes("/api/ui/v1/")) mutations.push(request.url());
    });
    await page.goto("/agents?agent=finance-fictional");
    await page.getByRole("button", { name: /Revisar gastos ficticios del mes/u }).click();
    await page.getByRole("link", { name: "Abrir conversación de origen" }).click();
    await expect(page).toHaveURL(/\/\?conversation=central-fictional-extra-0$/u);
    await expect(page.getByRole("button", { name: "Seleccionar Seguimiento 1" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Usar como conversación activa" })).toBeVisible();
    expect(mutations).toEqual([]);
  });
});
