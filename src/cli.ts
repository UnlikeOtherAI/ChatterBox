#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { backup } from "node:sqlite";
import { Board } from "./store.js";
import { serve } from "./server.js";
import {
  configPath,
  databasePath,
  initialize,
  readConfig,
  saveConfig,
  checkUrl,
} from "./config.js";
import { Discovery } from "./discovery.js";
import { setTimeout as delay } from "node:timers/promises";
import { runMcp } from "./mcp.js";
import { schemas } from "./types.js";

const help = `ChatterBox 0.1.0 — coordination for existing coding sessions

chatterbox init --project NAME [--workspace NAME]
chatterbox serve [--host 127.0.0.1] [--port 4318] [--cert FILE --key FILE]
chatterbox mcp --provider codex|claude-code --alias NAME --native-session UUID
  [--runtime cli|desktop] [--transport mailbox|codex-queue|claude-channel]
  [--executable /path/to/provider] [--config FILE] [--repository PATH] [--role NAME]
chatterbox grant --project NAME --url https://board.example --out FILE
chatterbox revoke --credential KEY_ID
chatterbox credentials
chatterbox backup --out FILE
chatterbox discover [--seconds 5]
chatterbox discover --provider claude-code [--executable PATH]

Data: ~/.chaterbox/data.db (override directory with CHATTERBOX_HOME).
MCP inherits CODEX_THREAD_ID or CLAUDE_SESSION_ID when available.
Registration requires an exact native identity; no title matching.
Configure MCP locally; the dashboard is read-only. See docs/getting-started.md.
`;
export async function runCli(args = process.argv.slice(2)) {
  const options: Record<string, { type: "string" | "boolean" }> =
    Object.fromEntries(
      [
        "project",
        "workspace",
        "host",
        "port",
        "cert",
        "key",
        "provider",
        "alias",
        "native-session",
        "runtime",
        "transport",
        "executable",
        "config",
        "repository",
        "role",
        "url",
        "out",
        "credential",
        "seconds",
        "mdns-name",
        "mdns-host",
      ].map((k) => [k, { type: "string" as const }]),
    );
  options.help = { type: "boolean" };
  options["no-mdns"] = { type: "boolean" };
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options,
  });
  const v = values as Record<string, string | boolean | undefined>;
  const opt = (key: string, fallback?: string): string =>
    typeof v[key] === "string" ? (v[key] as string) : (fallback ?? "");
  const command = positionals[0];
  if (!command || v.help) {
    console.log(help);
    return;
  }
  if (command === "init") {
    const c = initialize(
      opt("config", configPath()),
      opt("workspace", "local"),
      opt("project", "default"),
    );
    console.log(
      `Ready: ${c.workspace_id}/${c.project_id}\nDatabase: ${databasePath()}\nConnection: ${opt("config", configPath())}`,
    );
    return;
  }
  if (command === "serve") {
    initialize(
      opt("config", configPath()),
      opt("workspace", "local"),
      opt("project", "default"),
    );
    const b = new Board(databasePath());
    const port = Number(opt("port", "4318"));
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid port");
    const service = await serve(b, {
      host: opt("host", "127.0.0.1"),
      port,
      cert: opt("cert") || undefined,
      key: opt("key") || undefined,
      mdns: !v["no-mdns"],
      mdnsName: opt("mdns-name") || undefined,
      mdnsHost: opt("mdns-host") || undefined,
    });
    console.log(
      `ChatterBox listening on ${opt("host", "127.0.0.1")}:${service.port}`,
    );
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      void service.close().then(() => {
        b.close();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (command === "mcp") {
    const provider = opt("provider");
    const executable = opt(
      "executable",
      provider === "claude-code" ? "claude" : "codex",
    );
    const nativeId = opt(
      "native-session",
      provider === "codex"
        ? process.env.CODEX_THREAD_ID
        : process.env.CLAUDE_SESSION_ID,
    );
    if (!nativeId)
      throw new Error(
        "Provide --native-session or a provider-supplied session environment variable",
      );
    let version = "unknown";
    try {
      version = (
        await promisify(execFile)(executable, ["--version"], { timeout: 5000 })
      ).stdout
        .trim()
        .replace(/ \(Claude Code\)$/, "");
    } catch {
      /* Mailbox mode remains available without a provider binary. */
    }
    const registration = schemas.register.parse({
      native_session_id: nativeId,
      alias: opt("alias", `${provider}-${nativeId.slice(0, 8)}`),
      provider,
      provider_version: version,
      runtime_id: opt("runtime", "cli"),
      os: process.platform,
      transport: opt("transport", "mailbox"),
      repository: opt("repository", process.cwd()),
      role: opt("role", "developer"),
    });
    await runMcp(
      readConfig(opt("config", configPath())),
      registration,
      executable,
    );
    return;
  }
  if (command === "discover" && !opt("provider")) {
    const seconds = Number(opt("seconds", "5"));
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60)
      throw new Error("Discovery duration must be between 1 and 60 seconds");
    const discovery = new Discovery();
    try {
      await delay(seconds * 1000);
      console.log(JSON.stringify(discovery.snapshot(), null, 2));
    } finally {
      discovery.close();
    }
    return;
  }
  if (command === "discover") {
    if (opt("provider") !== "claude-code")
      throw new Error(
        "Use exact Codex native IDs from CODEX_THREAD_ID or the provider thread listing; file timestamps are only recency hints.",
      );
    const result = await promisify(execFile)(
      opt("executable", "claude"),
      ["agents", "--json"],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    console.log(result.stdout);
    return;
  }
  const board = new Board(databasePath());
  try {
    if (command === "grant") {
      if (!opt("out") || !opt("project") || !opt("url"))
        throw new Error("grant requires --out, --project and --url");
      const scope = {
        workspace_id: opt("workspace", "local"),
        project_id: opt("project"),
        machine_id: randomUUID(),
      };
      const url = checkUrl(opt("url"));
      if (existsSync(opt("out")))
        throw new Error("Connection file already exists");
      const token = board.issue(scope, "machine");
      const viewer_token = board.issue(scope, "viewer");
      saveConfig(opt("out"), { ...scope, board_url: url, token, viewer_token });
      console.log(
        `Connection written to ${opt("out")}. Transfer it privately to the participating machine.`,
      );
    } else if (command === "revoke") {
      if (!opt("credential")) throw new Error("revoke requires --credential");
      const result = board.run(
        "UPDATE credentials SET revoked=1 WHERE id=?",
        opt("credential"),
      );
      console.log(
        `Revoked ${result.changes} credential(s). Machine revocation also blocks its session credentials.`,
      );
    } else if (command === "credentials") {
      console.log(
        JSON.stringify(
          board.all(
            "SELECT id,workspace_id,project_id,machine_id,role,session_id,revoked FROM credentials ORDER BY workspace_id,project_id",
          ),
          null,
          2,
        ),
      );
    } else if (command === "backup") {
      if (!opt("out") || existsSync(opt("out")))
        throw new Error("backup requires a new --out path");
      await backup(board.db, opt("out"));
      if (process.platform !== "win32") chmodSync(opt("out"), 0o600);
      console.log(`Consistent SQLite backup written to ${opt("out")}`);
    } else throw new Error(`Unknown command: ${command}`);
  } finally {
    board.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
