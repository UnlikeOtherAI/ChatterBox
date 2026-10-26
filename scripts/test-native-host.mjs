// Optional live eval: uses local provider authentication and one model turn per
// selected provider. Never run in CI or a recurring model-polling loop.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Board } from "../dist/store.js";
import { serve } from "../dist/server.js";
import { runHost } from "../dist/host.js";
import { saveConfig } from "../dist/config.js";

const providers = [
  { provider: "codex", executable: process.env.CHATTERBOX_CODEX_EXECUTABLE },
  {
    provider: "claude-code",
    executable: process.env.CHATTERBOX_CLAUDE_EXECUTABLE,
  },
].filter((p) => p.executable);
const selection = process.env.CHATTERBOX_HOST_EVAL_MODEL
  ? {
      model: process.env.CHATTERBOX_HOST_EVAL_MODEL,
      reasoning_effort: process.env.CHATTERBOX_HOST_EVAL_REASONING ?? "low",
    }
  : {};
if (selection.model && providers.some((p) => p.provider !== "codex"))
  throw Error(
    "Explicit-model transcript verification currently requires a Codex-only eval",
  );
if (!providers.length)
  throw Error(
    "Set CHATTERBOX_CODEX_EXECUTABLE and/or CHATTERBOX_CLAUDE_EXECUTABLE to native binaries. This eval creates a new disposable headless worker for each selected provider.",
  );
mkdirSync("work", { recursive: true });
const directory = mkdtempSync(resolve("work/native-host-"));
const board = new Board(join(directory, "hub.db"));
const scope = {
  workspace_id: "disposable-test",
  project_id: "native-host",
  machine_id: randomUUID(),
};
const token = board.issue(scope, "machine"),
  machine = board.authenticate(token);
const service = await serve(board, { port: 0, mdns: false });
const connection = join(directory, "connection.json");
saveConfig(connection, {
  ...scope,
  board_url: `http://127.0.0.1:${service.port}`,
  token,
  viewer_token: board.issue(scope, "viewer"),
});
const coordinator = board.call(
  machine,
  "register",
  {
    native_session_id: randomUUID(),
    provider: "other",
    provider_version: "1",
    runtime_id: "native-host-eval",
    alias: "native-host-eval-coordinator",
    os: process.platform,
  },
  token,
);
const parent = board.authenticate(coordinator.token),
  hostId = randomUUID();
const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const base = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const hostFile = join(directory, "host.json");
writeFileSync(
  hostFile,
  JSON.stringify({
    host_id: hostId,
    name: `eval-${process.platform}`,
    connection,
    state_directory: join(directory, "state"),
    coordinators: selection.model ? [] : [coordinator.session_id],
    coordinator_grants: selection.model
      ? [
          {
            coordinator: coordinator.session_id,
            repositories: ["owned"],
            providers: [
              {
                provider: "codex",
                models: [selection.model],
                reasoning_efforts: [selection.reasoning_effort],
              },
            ],
          },
        ]
      : [],
    authorization_expires_at: Date.now() + 3600000,
    repositories: { owned: repository },
    providers,
  }),
  { mode: 0o600 },
);
const abort = new globalThis.AbortController();
const host = runHost(hostFile, abort.signal);
// Attach rejection immediately, so an early setup failure is observable below.
let hostError;
host.catch((e) => {
  hostError = e;
});
const evidence = [];
try {
  for (let i = 0; i < 100; i++) {
    if (hostError) throw hostError;
    if (board.one("SELECT 1 FROM lifecycle_hosts WHERE host_id=?", hostId))
      break;
    await delay(100);
  }
  assert.ok(
    board.one("SELECT 1 FROM lifecycle_hosts WHERE host_id=?", hostId),
    "Host must enroll before delegation",
  );
  for (const p of providers) {
    const marker = `HOST_EVAL_DONE_${p.provider}`;
    const requested = board.call(parent, "start_session", {
      host_id: hostId,
      provider: p.provider,
      mode: "headless",
      repository: "owned",
      ...selection,
      base_sha: base,
      assignment_id: `native-host-${p.provider}`,
      objective: `This is a bounded communication eval. Do not edit files, run tools, create other sessions or perform product work. After the required readiness line, continue the same response with a line containing exactly ${marker}. Do not end the turn after readiness.`,
      criteria: `The final assistant result must contain ${marker}; no source modifications.`,
      idempotency_key: randomUUID(),
    });
    const started = Date.now();
    let result;
    for (let i = 0; i < 1800; i++) {
      if (hostError) throw hostError;
      result = board.one(
        "SELECT * FROM lifecycle_launches WHERE launch_id=?",
        requested.launch_id,
      );
      if (["completed", "failed"].includes(result.state)) break;
      await delay(100);
    }
    assert.equal(
      result.state,
      "completed",
      `${p.provider}: ${result.state} ${result.detail}`,
    );
    assert.equal(result.ack_source, "native_assistant_output");
    assert.match(result.native_session_id, /^[a-f0-9-]{36}$/i);
    assert.ok(
      result.result.includes(marker),
      "Native assistant final output must contain the exact eval marker",
    );
    for (let i = 0; i < 150; i++) {
      if (
        board.one(
          "SELECT 1 FROM messages WHERE thread_id=? AND kind='result'",
          `launch:${result.launch_id}`,
        )
      )
        break;
      await delay(100);
    }
    assert.equal(
      board.one(
        "SELECT count(*) AS n FROM messages WHERE thread_id=? AND kind='result'",
        `launch:${result.launch_id}`,
      ).n,
      1,
      "Exactly one directed coordinator result",
    );
    let observed = {};
    if (selection.model) {
      const providerState = new DatabaseSync(
        join(
          process.env.CODEX_HOME ?? join(homedir(), ".codex"),
          "state_5.sqlite",
        ),
        { readOnly: true },
      );
      let rollout;
      try {
        rollout = providerState
          .prepare("SELECT rollout_path FROM threads WHERE id=?")
          .get(result.native_session_id)?.rollout_path;
      } finally {
        providerState.close();
      }
      assert.ok(
        rollout,
        "The exact native UUID must identify its own persisted transcript",
      );
      const transcript = readFileSync(rollout, "utf8");
      const records = transcript
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const metadata = records.find((v) => v.type === "session_meta")?.payload;
      assert.equal(metadata?.id, result.native_session_id);
      const journal = new DatabaseSync(
        join(directory, "state/host-journal.db"),
        { readOnly: true },
      );
      let worktree;
      try {
        worktree = journal
          .prepare("SELECT worktree FROM attempts WHERE launch_id=?")
          .get(result.launch_id)?.worktree;
      } finally {
        journal.close();
      }
      assert.equal(
        realpathSync.native(metadata.cwd),
        realpathSync.native(worktree),
      );
      const contexts = records
        .filter((v) => v.type === "turn_context")
        .map((v) => v.payload);
      assert.ok(
        contexts.length > 0,
        "Observed model proof requires a real native turn context",
      );
      for (const context of contexts) {
        assert.equal(context.model, selection.model);
        assert.equal(context.effort, selection.reasoning_effort);
      }
      observed = {
        requested_model: selection.model,
        requested_reasoning_effort: selection.reasoning_effort,
        observed_model: contexts[0].model,
        observed_reasoning_effort: contexts[0].effort,
        model_proof_source: "exact_native_transcript_turn_context",
        transcript_sha256: createHash("sha256")
          .update(transcript)
          .digest("hex"),
      };
    }
    evidence.push({
      provider: p.provider,
      os: process.platform,
      version: execFileSync(p.executable, ["--version"], {
        encoding: "utf8",
      }).trim(),
      launch_id: result.launch_id,
      native_session_id: result.native_session_id,
      ack_source: result.ack_source,
      state: result.state,
      result: result.result,
      elapsed_ms: Date.now() - started,
      base_sha: base,
      ...observed,
    });
    writeFileSync(
      join(directory, "evidence.json"),
      JSON.stringify(
        { captured_at: new Date().toISOString(), evidence },
        null,
        2,
      ),
    );
  }
  console.log(JSON.stringify({ fixture: directory, evidence }, null, 2));
} catch (error) {
  writeFileSync(join(directory, "failure.txt"), String(error));
  console.error(`Native host eval failed; fixture retained at ${directory}`);
  throw error;
} finally {
  abort.abort();
  await host;
  await service.close();
  board.close();
}
