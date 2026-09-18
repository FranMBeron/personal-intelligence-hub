import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const webPort = 4_400;
const fixturePort = 4_401;
const baseURL = `http://127.0.0.1:${webPort}`;
const fixtureURL = `http://127.0.0.1:${fixturePort}`;
const systemChrome = "/usr/bin/google-chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync(systemChrome) ? systemChrome : undefined);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  outputDir: "/tmp/pih-playwright-results",
  use: {
    baseURL,
    extraHTTPHeaders: {
      authorization: "Bearer e2e-fictional-delegated-token",
    },
    launchOptions: executablePath === undefined ? {} : { executablePath },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "node --conditions=development --import tsx e2e/fixture-server.ts",
      url: `${fixtureURL}/health/live`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `pnpm exec next dev --webpack --hostname 127.0.0.1 --port ${webPort}`,
      url: `${baseURL}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PIH_API_INTERNAL_URL: fixtureURL,
        HERMES_INTERNAL_URL: fixtureURL,
        HERMES_SERVICE_TOKEN: "e2e-fictional-service-token",
        HERMES_DASHBOARD_URL: "https://dashboard.example.test/hermes",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
