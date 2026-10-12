import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const systemChrome = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "/usr/bin/google-chrome";

export default defineConfig({
  testDir: "./e2e/desktop-layout",
  workers: 1,
  reporter: "line",
  outputDir: "/tmp/pih-desktop-layout-results",
  use: {
    baseURL: "http://127.0.0.1:4502",
    launchOptions: existsSync(systemChrome) ? { executablePath: systemChrome } : {},
  },
  webServer: {
    command: "pnpm --filter @personal-intelligence-hub/desktop exec vite build --config vite.renderer.config.ts && pnpm --filter @personal-intelligence-hub/desktop exec vite preview --config vite.renderer.config.ts --host 127.0.0.1 --port 4502 --strictPort",
    url: "http://127.0.0.1:4502",
    timeout: 30_000,
  },
});
