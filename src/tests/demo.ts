import { Board } from "../store.js";
import { saveConfig } from "../config.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
// Used only by isolated UI tests; never loaded by the application.
export function seedDemo(
  directory: string,
  port: number,
  empty = false,
  large = false,
) {
  const b = new Board(join(directory, "data.db"));
  const scope = {
    workspace_id: "studio",
    project_id: "desktop-app",
    machine_id: randomUUID(),
  };
  const token = b.issue(scope, "machine");
  saveConfig(join(directory, "connection.json"), {
    ...scope,
    board_url: `http://127.0.0.1:${port}`,
    token,
    viewer_token: b.issue(scope, "viewer"),
  });
  const m = b.authenticate(token);
  const agent = (alias: string, provider: string, os: string) => {
    const s = b.call(
      m,
      "register",
      {
        native_session_id: randomUUID(),
        provider,
        alias,
        os,
        provider_version:
          provider === "codex" ? "codex-cli 0.157.1" : "2.1.283",
        runtime_id: "cli",
        transport: "mailbox",
        repository: "desktop-app",
      },
      token,
    ) as { session_id: string; token: string };
    return { ...s, p: b.authenticate(s.token) };
  };
  if (!empty) {
    const mac = agent("mac-dev", "claude-code", "darwin");
    const win = agent("windows-dev", "codex", "win32");
    const linux = agent("linux-dev", "codex", "linux");
    const send = (
      from: typeof mac,
      to: typeof mac,
      kind: string,
      thread_id: string,
      body: string,
      commit_sha?: string,
    ) =>
      b.call(from.p, "send", {
        to: to.session_id,
        thread_id,
        kind,
        body,
        commit_sha,
        idempotency_key: randomUUID(),
      }) as { message_id: string };
    const a = send(
      mac,
      win,
      "handoff",
      "shared-serialization",
      "Updated the shared serialization format in a83f2c1.\nPlease pull before your next Windows build. The new enum keeps existing values stable.",
      "a83f2c1",
    );
    b.call(win.p, "ack", {
      message_id: a.message_id,
      acknowledgement: "completed",
      idempotency_key: randomUUID(),
    });
    send(
      win,
      mac,
      "result",
      "shared-serialization",
      "Windows build passes on the new revision. Serialization round trips are green across all fixtures.",
      "a83f2c1",
    );
    send(
      linux,
      mac,
      "decision",
      "sqlite-search",
      "SQLite FTS5 is available on all three hosts. We can keep the message history and search index in the same database.",
    );
    const d = send(
      mac,
      linux,
      "request",
      "sqlite-search",
      "Please check Unicode and prefix matching against the Linux build.\nI attached an embedding for the search fixture; use fixture-v1 when comparing vectors.",
    );
    b.call(mac.p, "embed", {
      message_id: d.message_id,
      model: "fixture-v1",
      vector: [0.8, 0.2, 0.3],
      idempotency_key: randomUUID(),
    });
    send(
      win,
      mac,
      "blocker",
      "windows-packaging",
      "The unsigned installer is ready for testing. Store submission is waiting on the publisher certificate.",
    );
    b.call(mac.p, "status", {
      state: "working",
      task: "Search interface and macOS package",
      revision: "a83f2c1",
      idempotency_key: randomUUID(),
    });
    b.call(win.p, "status", {
      state: "blocked",
      task: "Installer signing",
      idempotency_key: randomUUID(),
    });
    b.call(linux.p, "status", {
      state: "working",
      task: "Linux search verification",
      idempotency_key: randomUUID(),
    });
  }
  if (large) {
    const agents = Array.from({ length: 45 }, (_, i) =>
      agent(`page-agent-${String(i).padStart(3, "0")}`, "codex", "linux"),
    );
    const author = agents[0]!;
    for (let i = 0; i < 45; i++) {
      const board = b.call(author.p, "create_board", {
        name: `Task ${String(i).padStart(3, "0")}`,
        description: "Isolated pagination fixture",
        idempotency_key: randomUUID(),
      }) as { board_id: string };
      if (i < 2)
        for (let j = 0; j < (i === 0 ? 123 : 1); j++) {
          const message = b.call(author.p, "post", {
            board_id: board.board_id,
            body: `Pagination evidence ${j}`,
            kind: j % 2 ? "blocker" : "result",
            thread_id: "paged-thread",
            idempotency_key: randomUUID(),
          }) as { message_id: string };
          if (j === 122)
            for (let k = 0; k < 125; k++)
              b.event(author.p, "fixture", { index: k }, message.message_id);
        }
    }
  }
  b.close();
}
