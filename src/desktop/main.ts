import { app } from "electron";

// A packaged executable can also provide the CLI/MCP server without a window.
// Electron emits ready after entry-module evaluation, so never await it at top level.
const marker = process.argv.indexOf("--board-cli");
if (marker >= 0) {
  const args = process.argv.slice(marker + 1);
  void app.whenReady().then(async () => {
    try {
      const { runCli } = await import("../cli.js");
      await runCli(args);
      if (!["serve", "mcp"].includes(args[0] ?? "") || args.includes("--help"))
        app.quit();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      app.exit(1);
    }
  });
} else {
  await import("./window.js");
}
