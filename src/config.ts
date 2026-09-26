import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Board } from "./store.js";

export const dataHome = () =>
  resolve(process.env.CHATTERBOX_HOME ?? join(homedir(), ".chaterbox"));
export const databasePath = () => join(dataHome(), "data.db");
export const configPath = () => join(dataHome(), "connection.json");
export const configSchema = z
  .object({
    board_url: z.url(),
    workspace_id: z.string(),
    project_id: z.string(),
    machine_id: z.string(),
    token: z.string(),
    viewer_token: z.string(),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export function checkUrl(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Board URL must be an origin without credentials or a path",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error(
      "Remote connections require HTTPS. An SSH tunnel may use loopback HTTP.",
    );
  return url.origin;
}
export function saveConfig(path: string, config: Config) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
export function readConfig(path = configPath()): Config {
  const config = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  checkUrl(config.board_url);
  return config;
}
export function initialize(
  path = configPath(),
  workspace_id = "local",
  project_id = "default",
  board_url = "http://127.0.0.1:4318",
): Config {
  if (existsSync(path)) return readConfig(path);
  checkUrl(board_url);
  const board = new Board(databasePath());
  try {
    let machine = board.one<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      "machine_id",
    )?.value;
    if (!machine) {
      machine = randomUUID();
      board.run("INSERT INTO meta VALUES (?,?)", "machine_id", machine);
    }
    const scope = { workspace_id, project_id, machine_id: machine };
    const config = {
      ...scope,
      board_url,
      token: board.issue(scope, "machine"),
      viewer_token: board.issue(scope, "viewer"),
    };
    saveConfig(path, config);
    return config;
  } finally {
    board.close();
  }
}
