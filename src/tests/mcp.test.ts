import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { Board } from "../store.js";
import { serve } from "../server.js";
import { saveConfig } from "../config.js";

test("two real stdio MCP connections register, send, search, embed, acknowledge and resume", async () => {
  mkdirSync(resolve("work"), { recursive: true });
  const dir = mkdtempSync(resolve("work/mcp-test-"));
  const board = new Board(join(dir, "hub.db"));
  const service = await serve(board, { port: 0 });
  const sessions: {
    client: Client;
    transport: StdioClientTransport;
    native: string;
    alias: string;
  }[] = [];
  const scope = {
    workspace_id: "test",
    project_id: "mcp-project",
    machine_id: randomUUID(),
  };
  const config = join(dir, "connection.json");
  saveConfig(config, {
    ...scope,
    board_url: `http://127.0.0.1:${service.port}`,
    token: board.issue(scope, "machine"),
    viewer_token: board.issue(scope, "viewer"),
  });
  const connect = async (alias: string, native = randomUUID()) => {
    const transport = new StdioClientTransport({
      command: process.env.CHATTERBOX_TEST_CLI ?? process.execPath,
      args: [
        process.env.CHATTERBOX_TEST_CLI ? "--board-cli" : "dist/cli.js",
        "mcp",
        "--provider",
        "codex",
        "--executable",
        "nonexistent-chatterbox-test-provider",
        "--native-session",
        native,
        "--alias",
        alias,
        "--config",
        config,
      ],
      cwd: process.cwd(),
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (e): e is [string, string] =>
              e[1] !== undefined && e[0] !== "ELECTRON_RUN_AS_NODE",
          ),
        ),
        CHATTERBOX_HOME: join(dir, alias),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "chatterbox-test", version: "1.0.0" });
    await client.connect(transport);
    const record = { client, transport, native, alias };
    sessions.push(record);
    return record;
  };
  const call = async <T>(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0]!.text) as T;
  };
  try {
    const a = await connect("mac-dev");
    const b = await connect("windows-dev");
    const tools = await a.client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "board_search"));
    assert.ok(tools.tools.some((t) => t.name === "board_embed"));
    const registration = await call<{ session_id: string; capability: string }>(
      a.client,
      "board_register",
    );
    assert.equal(registration.capability, "MAILBOX");
    const m = await call<{ message_id: string }>(a.client, "board_send", {
      to: "windows-dev",
      thread_id: "native-build",
      body: "Fulltext SQLite search is ready for Windows.",
      idempotency_key: randomUUID(),
    });
    await call(a.client, "board_embed", {
      message_id: m.message_id,
      model: "fixture-v1",
      vector: [1, 0],
      idempotency_key: randomUUID(),
    });
    const found = await call<{ messages: { message_id: string }[] }>(
      b.client,
      "board_search",
      { query: "fulltext wind" },
    );
    assert.equal(found.messages[0]!.message_id, m.message_id);
    await call(b.client, "board_ack", {
      message_id: m.message_id,
      acknowledgement: "received",
      idempotency_key: randomUUID(),
    });
    const pending = await call<{ messages: unknown[] }>(
      b.client,
      "board_messages",
      { pending: true },
    );
    assert.equal(pending.messages.length, 0);
    await a.client.close();
    const resumed = await connect("mac-dev", a.native);
    const after = await call<{ session_id: string }>(
      resumed.client,
      "board_register",
    );
    assert.equal(after.session_id, registration.session_id);
  } finally {
    for (const { client } of sessions) await client.close();
    await service.close();
    board.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
