import { resolve } from "node:path";
import { runIconsTool } from "app-builder-lib/out/toolsets/icons.js";

// Use the icon converter bundled with the pinned electron-builder dependency.
// The committed PNG is the user-supplied artwork, including its white background.
for (const outputFormat of ["icns", "ico", "set"]) {
  await runIconsTool({
    inputFile: resolve("assets/icon.png"),
    outputFormat,
    outDir: resolve(outputFormat === "set" ? "assets/icons" : "assets"),
  });
}
