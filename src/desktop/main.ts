import { app } from "electron";

// The packaged executable doubles as the board CLI and stdio MCP server.
// This branch creates no window and never starts or replaces a coding agent.
const marker = process.argv.indexOf("--board-cli");
if (marker >= 0) {
  const args = process.argv.slice(marker + 1);
  const { runCli } = await import("../cli.js");
  await app.whenReady();
  try {
    await runCli(args);
    if (!["serve", "mcp"].includes(args[0] ?? "") || args.includes("--help"))
      app.quit();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    app.exit(1);
  }
} else {
  await import("./window.js");
}
