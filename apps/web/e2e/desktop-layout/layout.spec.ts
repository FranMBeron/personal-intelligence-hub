import { expect, test } from "@playwright/test";

// Content areas (window minus a 28px title bar): default control, its minimum, a
// low-height work area that clamps height only, and the remote hub's initial size.
for (const viewport of [
  { width: 720, height: 672 }, { width: 480, height: 612 },
  { width: 720, height: 612 }, { width: 1024, height: 740 },
]) {
  for (const view of ["setup", "invalid", "settings", "unavailable"] as const) {
    test(`${view} controls fit the supported ${viewport.width}x${viewport.height} viewport`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(({ requestedView }) => {
        const origin = "https://a-long-example-server-name.example.test:8443";
        const state = {
          settings: { serverOrigin: ["setup", "invalid"].includes(requestedView) ? null : origin, launchAtLogin: false },
          connection: ["setup", "invalid"].includes(requestedView) ? { kind: "unconfigured" } : requestedView === "unavailable"
            ? { kind: "unavailable", origin, reason: "network-error" } : { kind: "connected", origin },
          launchAtLogin: { supported: true, requested: false, enabled: false },
        };
        Object.defineProperty(window, "desktop", { value: {
          readState: async () => state,
          validateServer: async () => { throw new Error("Invalid fixture origin"); },
        } });
      }, { requestedView: view });
      await page.goto(view === "settings" ? "/?view=settings" : "/");
      await expect(page.getByLabel("Launch at login", { exact: true })).toBeVisible();
      if (view === "invalid") {
        await page.getByLabel("Server URL", { exact: true }).fill("http://example.test");
        await page.getByRole("button", { name: "Connect to Hub", exact: true }).click();
        await expect(page.getByRole("alert")).toBeVisible();
      }
      const geometry = await page.evaluate(() => {
        const controls = [...document.querySelectorAll("button, input, #login-status, footer")];
        return {
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          verticalOverflow: document.documentElement.scrollHeight > innerHeight,
          clippedControls: controls.filter((control) => {
            const rect = control.getBoundingClientRect();
            return rect.top < 0 || rect.left < 0 || rect.right > innerWidth || rect.bottom > innerHeight;
          }).map((control) => control.id || control.textContent),
        };
      });
      expect(geometry.horizontalOverflow).toBe(false);
      expect(geometry.verticalOverflow).toBe(false);
      expect(geometry.clippedControls).toEqual([]);
    });
  }
}
