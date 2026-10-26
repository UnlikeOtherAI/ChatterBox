import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Board } from "../dist/store.js";
import { Client } from "../dist/client.js";
import { Adapter } from "../dist/adapter.js";
import { serve } from "../dist/server.js";
import { saveConfig } from "../dist/config.js";
import { connectAppServer, codexSteer } from "../dist/codex-steer.js";

const executable = process.env.CHATTERBOX_CODEX_EXECUTABLE;
if (!executable)
  throw Error(
    "Set CHATTERBOX_CODEX_EXECUTABLE to the native Codex 0.159.2 executable. This optional eval uses provider authentication and a disposable model turn.",
  );
mkdirSync("work", { recursive: true });
const dir = mkdtempSync(resolve("work/native-steering-"));
const board = new Board(join(dir, "hub.db"));
const scope = {
  workspace_id: "disposable-test",
  project_id: "steering",
  machine_id: randomUUID(),
};
const token = board.issue(scope, "machine");
const machine = board.authenticate(token);
const service = await serve(board, { port: 0, mdns: false });
const config = join(dir, "connection.json");
saveConfig(config, {
  ...scope,
  board_url: `http://127.0.0.1:${service.port}`,
  token,
  viewer_token: board.issue(scope, "viewer"),
});
const sender = board.call(
  machine,
  "register",
  {
    native_session_id: randomUUID(),
    provider: "other",
    provider_version: "1",
    runtime_id: "test",
    alias: "eval-sender",
    os: process.platform,
  },
  token,
);
const senderPrincipal = board.authenticate(sender.token);
const reserve = createServer();
await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
const port = reserve.address().port;
await new Promise((r) => reserve.close(r));
const url = `ws://127.0.0.1:${port}`;
const child = spawn(
  executable,
  ["app-server", "--listen", url, "-c", "mcp_servers.chatterbox.enabled=false"],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
let diagnostics = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (d) => {
    diagnostics = (diagnostics + String(d)).slice(-4000);
  });
const spool = new Board(join(dir, "recipient-spool.db"));
let runtime, adapter;
try {
  for (let n = 0; n < 40; n++) {
    try {
      runtime = await connectAppServer(url);
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(runtime, "disposable runtime did not start");
  const started = await runtime.call("thread/start", {
    cwd: dir,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  const nativeId = started.thread.id;
  writeFileSync(
    join(dir, "native-identity.json"),
    JSON.stringify({ nativeId, path: started.thread.path }, null, 2),
  );
  const setup = await runtime.call("turn/start", {
    threadId: nativeId,
    input: [
      {
        type: "text",
        text: "Disposable transport-test setup. Reply SETUP_READY only. Do not use tools, edit files, or contact peers.",
        text_elements: [],
      },
    ],
  });
  let setupComplete = false;
  for (let n = 0; n < 120; n++) {
    try {
      const read = await runtime.call("thread/read", {
        threadId: nativeId,
        includeTurns: true,
      });
      if (
        read.thread.turns.some(
          (turn) => turn.id === setup.turn.id && turn.status === "completed",
        )
      ) {
        setupComplete = true;
        break;
      }
    } catch {
      /* wait for provider metadata flush */
    }
    await delay(250);
  }
  assert.ok(setupComplete, "native setup turn did not complete");
  await runtime.call("thread/unsubscribe", { threadId: nativeId });
  // Test setup only: bind MCP explicitly to the already-created disposable ID.
  // The delivery adapter itself never resumes or starts a native thread.
  await runtime.call("thread/resume", {
    threadId: nativeId,
    config: {
      "mcp_servers.chatterbox_probe": {
        command: process.execPath,
        args: [
          resolve("dist/cli.js"),
          "mcp",
          "--provider",
          "codex",
          "--runtime",
          "shared-app-server",
          "--native-session",
          nativeId,
          "--transport",
          "mailbox",
          "--alias",
          "native-eval-recipient",
          "--config",
          config,
          "--executable",
          executable,
        ],
        env: { CHATTERBOX_HOME: join(dir, "mcp-spool") },
        startup_timeout_sec: 20,
      },
    },
  });
  await runtime.call("thread/name/set", {
    threadId: nativeId,
    name: "ChatterBox disposable steering verification",
  });
  const recipient = board.call(
    machine,
    "register",
    {
      native_session_id: nativeId,
      provider: "codex",
      provider_version: "codex-cli 0.159.2",
      runtime_id: "shared-app-server",
      alias: "native-eval-recipient",
      os: process.platform,
      transport: "codex-steer",
    },
    token,
  );
  // The recipient's MCP connection uses mailbox to expose ack only; the eval
  // harness owns the steering adapter and its transport registration.
  const turn = await runtime.call("turn/start", {
    threadId: nativeId,
    input: [
      {
        type: "text",
        text: "This is a disposable ChatterBox integration test. Do not edit files or contact any real peers. Run the shell command Start-Sleep -Seconds 20 once, then answer ORIGINAL_COMPLETE. A ChatterBox message may arrive while waiting. If one does, read its Message ID, call the chatterbox_probe board_ack tool with acknowledgement received and a fresh idempotency_key, and include the message marker and RECEIVED in your final answer. Do not send messages or start any other agents.",
        text_elements: [],
      },
    ],
  });
  const readThread = async (nativeId) => {
    for (let n = 0; n < 20; n++) {
      try {
        return await runtime.call("thread/read", {
          threadId: nativeId,
          includeTurns: true,
        });
      } catch (error) {
        if (n === 19) throw error;
        await delay(250);
      }
    }
  };
  let observedTool = false;
  for (let n = 0; n < 120; n++) {
    let records = [];
    try {
      records = readFileSync(started.thread.path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      /* provider may not have flushed its first records yet */
    }
    const calls = records
      .filter((r) => r.type === "response_item")
      .map((r) => r.payload);
    observedTool = calls.some(
      (item) =>
        item.type === "custom_tool_call" &&
        item.name === "exec" &&
        item.input.includes("Start-Sleep") &&
        !calls.some(
          (output) =>
            output.type === "custom_tool_call_output" &&
            output.call_id === item.call_id,
        ),
    );
    if (observedTool) break;
    await delay(250);
  }
  assert.ok(
    observedTool,
    "native turn did not enter the expected active tool boundary",
  );
  // Refresh the exact test identity as steer-capable after MCP startup.
  board.call(
    machine,
    "register",
    {
      native_session_id: nativeId,
      provider: "codex",
      provider_version: "codex-cli 0.159.2",
      runtime_id: "shared-app-server",
      alias: "native-eval-recipient",
      os: process.platform,
      transport: "codex-steer",
    },
    token,
  );
  const marker = "STEER_" + randomUUID();
  const began = Date.now();
  const sent = board.call(senderPrincipal, "send", {
    to: recipient.session_id,
    body: `Delivery verification marker ${marker}. Please acknowledge this exact message with board_ack received and include this marker with RECEIVED in your final answer.`,
    thread_id: "native-eval",
    idempotency_key: randomUUID(),
  });
  let receiptAt;
  adapter = new Adapter(
    new Client(`http://127.0.0.1:${service.port}`, token),
    spool,
    recipient.session_id,
    "codex-steer",
    async (message) => {
      const receipt = await codexSteer(url, nativeId, message);
      receiptAt = Date.now();
      return receipt;
    },
  );
  await adapter.tick();
  const receipt = board.one(
    "SELECT state,detail FROM deliveries WHERE message_id=?",
    sent.message_id,
  );
  assert.equal(receipt.state, "steer_accepted", JSON.stringify(receipt));
  let transcript;
  for (let n = 0; n < 180; n++) {
    const result = await readThread(nativeId);
    const active = result.thread.turns.find((t) => t.id === turn.turn.id);
    if (active?.status === "completed") {
      transcript = active;
      break;
    }
    if (active?.status === "failed") throw Error("native model turn failed");
    await delay(500);
  }
  assert.ok(
    transcript,
    "native turn did not complete within the eval deadline",
  );
  const assistantText = transcript.items
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text)
    .join("\n");
  assert.ok(
    assistantText.includes(marker) && assistantText.includes("RECEIVED"),
    "native assistant output did not acknowledge the marker",
  );
  const delivery = board.one(
    "SELECT state,acknowledgement FROM deliveries WHERE message_id=?",
    sent.message_id,
  );
  assert.equal(
    delivery.acknowledgement,
    "received",
    "native model did not explicitly acknowledge through MCP",
  );
  const evidence = {
    date: new Date().toISOString(),
    host: process.env.COMPUTERNAME ?? process.platform,
    provider: runtime.userAgent,
    native_thread_id: nativeId,
    native_turn_id: turn.turn.id,
    message_id: sent.message_id,
    transport: "codex-steer",
    board_acceptance_to_native_transport_ms: receiptAt - began,
    board_acceptance_to_authenticated_ack_ms:
      board.one(
        "SELECT created_at FROM events WHERE message_id=? AND type='acknowledgement' ORDER BY seq LIMIT 1",
        sent.message_id,
      ).created_at - began,
    board_acceptance_to_observed_completion_ms: Date.now() - began,
    active_tool_boundary_observed: true,
    exact_turn_matched: true,
    native_transcript_contains_marker: true,
    acknowledgement: delivery.acknowledgement,
    delivery_state: delivery.state,
    limits: [
      "Shared app-server explicitly created for this disposable test; this does not prove attachment to an unrelated Codex Desktop owner",
      "One setup turn and one steering test turn; no production conversations used",
      "No queue fallback was invoked",
    ],
  };
  const evidencePath = join(dir, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    JSON.stringify({ evidence_file: evidencePath, ...evidence }, null, 2),
  );
} catch (error) {
  console.error("Native eval failed:", error.message);
  writeFileSync(join(dir, "failure.txt"), String(error) + "\n" + diagnostics);
  process.exitCode = 1;
} finally {
  await adapter?.stop();
  runtime?.close();
  child.kill();
  await service.close();
  spool.close();
  board.close();
}
