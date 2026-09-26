import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataHome } from "../config.js";

export function readTrayPreference(): boolean {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(dataHome(), "desktop.json"), "utf8"),
    );
    return (
      typeof value === "object" &&
      value !== null &&
      "tray_only" in value &&
      value.tray_only === true
    );
  } catch {
    // A missing or damaged preference must never strand the app off-screen.
    return false;
  }
}

export function saveTrayPreference(enabled: boolean): void {
  const directory = dataHome();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.desktop-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ tray_only: enabled })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, join(directory, "desktop.json"));
  } finally {
    rmSync(temporary, { force: true });
  }
}
