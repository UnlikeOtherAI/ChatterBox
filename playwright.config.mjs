import { defineConfig } from "@playwright/test";
// The native webContents.close test path can leave macOS Electron alive after quit.
// Use Playwright's CDP page-close path; app.close still performs normal app cleanup.
if (process.platform === "darwin")
  process.env.PLAYWRIGHT_ELECTRON_LEGACY_PAGE_CLOSE = "1";

export default defineConfig({
  testDir: "./tests",
  timeout: 60000,
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
