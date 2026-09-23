import { expect, test } from "@playwright/test";

const fixtureURL = "http://127.0.0.1:4401";

test.beforeEach(async ({ request }) => {
  await request.post(`${fixtureURL}/__control`, {
    data: { api: "available", hermes: "available" },
  });
});

test("uses every interface and streams conversations without exposing runtime values", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByText("Revisar la nota de arquitectura")).toBeVisible();
  await expect(page.getByRole("button", { name: "Añadir adjunto" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Añadir voz" })).toBeDisabled();
  await page.getByLabel("Mensaje para Hermes").fill("Resume mis prioridades");
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByText("Tu prioridad principal es revisar la nota.")).toBeVisible();

  await page.getByRole("link", { name: "Agentes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agentes" })).toBeVisible();
  await page.getByRole("button", { name: "Conversar con Research Agent" }).click();
  const agentCard = page.locator("article.agent-card").filter({ hasText: "Research Agent" });
  await agentCard.getByLabel("Mensaje para Hermes").fill("Estado de investigación");
  await agentCard.getByRole("button", { name: "Enviar" }).click();
  await expect(agentCard.getByText("Research Agent está listo.")).toBeVisible();

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
  await expect(page.getByText("Disponible", { exact: true })).toHaveCount(2);
  await expect(page.getByText("No configurado", { exact: true })).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText("e2e-fictional-delegated-token");
  await expect(page.locator("body")).not.toContainText("e2e-fictional-service-token");
  expect(consoleErrors).toEqual([]);
});

test("shows verified source-down states", async ({ page, request }) => {
  await request.post(`${fixtureURL}/__control`, {
    data: { api: "unavailable", hermes: "unavailable" },
  });

  await page.goto("/");
  await expect(page.getByText("Prioridades no disponibles")).toBeVisible();
  await expect(page.getByText("Hermes no disponible")).toBeVisible();
  await expect(page.locator(".hoy-hero")).toBeVisible();
  await expect(page.locator(".day-grid")).toBeVisible();
  await page.goto("/system");
  await expect(page.getByText("No disponible", { exact: true })).toHaveCount(2);
  await expect(page.locator(".system-health")).toBeVisible();
  await expect(page.locator(".system-metrics")).toBeVisible();
});

test("renders the approved shell and page compositions", async ({ page }, testInfo) => {
  const routes = [
    { path: "/", name: "hoy", composition: ".hoy-hero" },
    { path: "/agents", name: "agentes", composition: ".agent-summary" },
    { path: "/second-brain", name: "second-brain", composition: ".brain-workspace" },
    { path: "/system", name: "sistema", composition: ".system-health" },
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
