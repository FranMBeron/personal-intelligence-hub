import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

/**
 * Layout acceptance against the fictional connectors stack (e2e/connectors-stack.ts).
 * Every check measures rendered boxes: zero intersections between neighbours, controls inside
 * their containers, the composer clear of the bottom navigation and no horizontal page scroll.
 */
const control = "http://127.0.0.1:4411/__control";
const screenshots = process.env.PIH_LAYOUT_SCREENSHOTS ?? "/tmp/pih-connectors-layout";
const widths = [360, 390, 480, 700, 701, 900, 901, 1024, 1440] as const;
const routes = [
  { path: "/", name: "hoy" },
  { path: "/agents", name: "agentes" },
  { path: "/second-brain", name: "second-brain" },
  { path: "/system", name: "sistema" },
] as const;

type Scenario = "normal" | "long" | "empty" | "error" | "pending";

test.use({ baseURL: "http://127.0.0.1:4410", extraHTTPHeaders: { "x-forwarded-for": "100.64.0.10" } });
test.setTimeout(180_000);

const setScenario = async (page: Page, scenario: Scenario) => {
  const response = await page.request.post(control, { data: { scenario } });
  expect(response.ok()).toBe(true);
};

type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

/** Strict intersection with a half-pixel tolerance for sub-pixel rounding. */
const overlaps = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;

const box = async (page: Page, selector: string): Promise<Box> => {
  const locator = page.locator(selector).first();
  await expect(locator, `${selector} is rendered`).toBeVisible();
  const value = await locator.boundingBox();
  if (value === null) throw new Error(`${selector} has no box`);
  return value;
};

const expectApart = async (page: Page, first: string, second: string, label: string) => {
  expect(overlaps(await box(page, first), await box(page, second)), `${label}: ${first} must not intersect ${second}`).toBe(false);
};

/** Every visible control lies inside its nearest layout container and inside the viewport width. */
const escapedControls = (page: Page) => page.evaluate(() => {
  const failures: string[] = [];
  const width = document.documentElement.clientWidth;
  for (const element of document.querySelectorAll<HTMLElement>("main button, main a[href], main input, main select, main textarea")) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || getComputedStyle(element).visibility === "hidden") continue;
    if (element.closest(".sr-only, .live-region") !== null) continue;
    const label = `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}"`;
    if (rect.left < -0.5 || rect.right > width + 0.5) failures.push(`${label} leaves the viewport`);
    const container = element.parentElement?.closest<HTMLElement>("section, article, form, header, fieldset, li, .panel");
    if (container === null || container === undefined) continue;
    const outer = container.getBoundingClientRect();
    // Scrollable containers may legitimately clip; only flow containers must enclose their controls.
    const style = getComputedStyle(container);
    if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) continue;
    if (rect.left < outer.left - 0.5 || rect.right > outer.right + 0.5 || rect.top < outer.top - 0.5 || rect.bottom > outer.bottom + 0.5) {
      failures.push(`${label} escapes ${container.tagName.toLowerCase()}.${container.className}`);
    }
  }
  return failures;
});

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Conversation event streams stay open, so "settled" means no visible loading copy rather than network idle. */
const waitForSettled = async (page: Page) => {
  await page.waitForLoadState("load");
  await expect(page.locator("main").getByText(/^Cargando/u)).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
};

/** Focusing the composer scrolls it into view; the sticky navigation must not cover it. */
const expectComposerClearOfNavigation = async (page: Page, label: string) => {
  const textarea = page.locator("main .composer textarea").first();
  if (await textarea.count() === 0) return;
  await textarea.focus();
  await page.waitForTimeout(50);
  const composer = await box(page, "main .composer");
  const navigation = await box(page, ".app-shell > .app-navigation");
  expect(overlaps(composer, navigation), `${label}: composer must not sit under the navigation`).toBe(false);
};

const expectAgentsLayout = async (page: Page, label: string) => {
  await expectApart(page, ".page-header", ".agents-roster__metrics", label);
  await expectApart(page, ".page-header", ".agents-roster__filters", label);
  await expectApart(page, ".agents-roster__metrics", ".agents-roster__filters", label);
  await expectApart(page, ".agents-roster__filters", ".agents-roster__roster", label);
  await expectApart(page, ".agents-roster__metrics", ".agents-roster__roster", label);
  const filters = await page.locator(".agents-roster__filter").all();
  const boxes = await Promise.all(filters.map(async (filter) => (await filter.boundingBox())!));
  for (let left = 0; left < boxes.length; left += 1) {
    expect(boxes[left]!.height, `${label}: filter target height`).toBeGreaterThanOrEqual(44);
    for (let right = left + 1; right < boxes.length; right += 1) {
      expect(overlaps(boxes[left]!, boxes[right]!), `${label}: filters ${left} and ${right}`).toBe(false);
    }
  }
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".agents-roster__filters")!).position)).toBe("static");
};

test.beforeAll(() => mkdirSync(screenshots, { recursive: true }));

for (const width of widths) {
  test(`long content leaves no intersections at ${width}px`, async ({ page }) => {
    await setScenario(page, "long");
    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      await page.goto(route.path);
      await waitForSettled(page);
      const label = `${route.name}@${width}`;
      expect(await noHorizontalScroll(page), `${label}: no horizontal page scroll`).toBe(true);
      expect(await escapedControls(page), `${label}: controls inside their containers`).toEqual([]);
      if (route.path === "/agents") {
        await expectAgentsLayout(page, label);
        await page.getByRole("button", { name: /^Conversar con Finanzas/u }).click();
        await expect(page.getByRole("region", { name: /^Espacio de conversación de Finanzas/u })).toBeVisible();
        await waitForSettled(page);
        expect(await escapedControls(page), `${label}: workspace controls inside their containers`).toEqual([]);
        expect(await noHorizontalScroll(page), `${label}: workspace has no horizontal scroll`).toBe(true);
      }
      await expectComposerClearOfNavigation(page, label);
      await page.screenshot({ path: `${screenshots}/long-${route.name}-${width}.png`, fullPage: true });
    }
  });
}

test("short viewports keep the composer and filters clear", async ({ page }) => {
  await setScenario(page, "long");
  for (const viewport of [{ width: 360, height: 560 }, { width: 1024, height: 600 }]) {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(route.path);
      await waitForSettled(page);
      const label = `${route.name}@${viewport.width}x${viewport.height}`;
      expect(await noHorizontalScroll(page), label).toBe(true);
      if (route.path === "/agents") await expectAgentsLayout(page, label);
      await expectComposerClearOfNavigation(page, label);
      await page.screenshot({ path: `${screenshots}/short-${route.name}-${viewport.width}x${viewport.height}.png`, fullPage: true });
    }
  }
});

test("four agent metrics share one row when there is room", async ({ page }) => {
  await setScenario(page, "normal");
  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/agents");
    const tops = await page.locator(".agents-roster__metric").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
    expect(tops).toHaveLength(4);
    expect(new Set(tops).size, `metrics in one row at ${width}px`).toBe(1);
  }
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/agents");
  await expectAgentsLayout(page, "agentes@360 normal");
});

for (const scenario of ["empty", "error", "pending"] as const) {
  test(`${scenario} states stay honest and contained`, async ({ page }) => {
    await setScenario(page, scenario);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of routes) {
        await page.goto(route.path, { waitUntil: "domcontentloaded" });
        if (scenario !== "pending") await waitForSettled(page);
        const label = `${scenario}:${route.name}@${width}`;
        await expect(page.locator("main h1")).toBeVisible();
        expect(await noHorizontalScroll(page), label).toBe(true);
        expect(await escapedControls(page), label).toEqual([]);
        if (route.path === "/agents") await expectAgentsLayout(page, label);
        await expect(page.locator("main")).not.toContainText(/Etapa \d|Todo funciona|undefined|NaN/u);
        await page.screenshot({ path: `${screenshots}/${scenario}-${route.name}-${width}.png`, fullPage: true });
      }
    }
  });
}

test("every tab reuses the configured Central profile and rendering performs no mutation", async ({ page }) => {
  await setScenario(page, "normal");
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/api/ui/v1/")) mutations.push(`${request.method()} ${request.url()}`);
  });
  for (const path of ["/", "/system", "/second-brain"]) {
    await page.goto(path);
    await expect(page.getByRole("region", { name: "Espacio de conversación de Central" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Seleccionar Principal" })).toHaveAttribute("aria-pressed", "true");
  }
  await page.goto("/system?proposal=opaque-proposal-7f3");
  await expect(page.getByRole("button", { name: "Confirmar cambio" })).toBeVisible();
  expect(mutations).toEqual([]);
});
