import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const paths =
  process.platform === "darwin"
    ? [
        `release/mac-${process.arch}/ChatterBox.app/Contents/MacOS/ChatterBox`,
        "release/mac/ChatterBox.app/Contents/MacOS/ChatterBox",
      ]
    : process.platform === "win32"
      ? ["release/win-unpacked/ChatterBox.exe"]
      : ["release/linux-unpacked/chatterbox"];
const executable = paths.map((p) => resolve(p)).find(existsSync);
if (!executable)
  throw new Error("Build an unpacked package before testing it.");
const env = {
  ...process.env,
  CHATTERBOX_TEST_EXECUTABLE: executable,
  CHATTERBOX_TEST_CLI: executable,
};
delete env.ELECTRON_RUN_AS_NODE;
for (const args of [
  ["--test", "dist/tests/mcp.test.js"],
  ["node_modules/@playwright/test/cli.js", "test"],
]) {
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
