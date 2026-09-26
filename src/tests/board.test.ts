import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { Board } from "../store.js";
import { BoardError, type Message, type Principal } from "../types.js";
import { serve } from "../server.js";
import { Client } from "../client.js";
import { Adapter, type Claimed } from "../adapter.js";

const key = () => randomUUID();
function fixture(path = ":memory:") {
  let clock = Date.now();
  const board = new Board(path, () => clock);
  function machine(project = "app") {
    const token = board.issue(
      { workspace_id: "test", project_id: project, machine_id: key() },
      "machine",
    );
    return { token, principal: board.authenticate(token) };
  }
  function register(
    m: ReturnType<typeof machine>,
    alias: string,
    native = key(),
    transport = "mailbox",
  ) {
    const result = board.call(
      m.principal,
      "register",
      {
        native_session_id: native,
        provider: "codex",
        provider_version: "codex-cli 0.157.1",
        runtime_id: "cli",
        alias,
        os: "darwin",
        transport,
      },
      m.token,
    ) as { session_id: string; token: string; capability: string };
    return { ...result, principal: board.authenticate(result.token) };
  }
  const aMachine = machine(),
    bMachine = machine();
  const a = register(aMachine, "mac-dev"),
    b = register(bMachine, "windows-dev");
  const send = (
    from = a.principal,
    to = b.session_id,
    body = "Please verify SQLite search on Windows.",
    idempotency_key = key(),
  ) =>
    board.call(from, "send", {
      to,
      body,
      thread_id: "build",
      idempotency_key,
    }) as { message_id: string; state: string };
  return {
    board,
    machine,
    register,
    aMachine,
    bMachine,
    a,
    b,
    send,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
function failure(fn: () => unknown, status: number) {
  assert.throws(fn, (e) => e instanceof BoardError && e.status === status);
}

test("task boards have stable shared IDs, bounded pages, scoped search and idempotent creation", () => {
  const f = fixture();
  try {
    const input = {
      name: "Same task title",
      description: "Shared across machines",
      idempotency_key: key(),
    };
    const created = f.board.call(f.a.principal, "create_board", input) as {
      board_id: string;
    };
    assert.deepEqual(
      f.board.call(f.a.principal, "create_board", input),
      created,
    );
    failure(
      () =>
        f.board.call(f.a.principal, "create_board", {
          ...input,
          name: "Changed",
        }),
      409,
    );
    const other = f.board.call(f.b.principal, "create_board", {
      ...input,
      idempotency_key: key(),
    }) as { board_id: string };
    assert.notEqual(created.board_id, other.board_id);
    const first = f.board.call(f.b.principal, "boards", { limit: 2 }) as {
      boards: { board_id: string }[];
      cursor: string;
    };
    assert.equal(first.boards.length, 2);
    const second = f.board.call(f.b.principal, "boards", {
      limit: 2,
      cursor: first.cursor,
    }) as { boards: { board_id: string }[]; cursor: string | null };
    assert.notEqual(second.boards[0]!.board_id, other.board_id);
    assert.equal(first.boards[0]!.board_id, other.board_id);
    assert.equal(second.cursor, null);
    for (let i = 0; i < 3; i++)
      f.board.call(f.a.principal, "post", {
        board_id: created.board_id,
        body: `Evidence café ${i}`,
        thread_id: "same-thread",
        idempotency_key: key(),
      });
    f.board.call(f.b.principal, "post", {
      board_id: other.board_id,
      body: "Evidence other board",
      thread_id: "same-thread",
      idempotency_key: key(),
    });
    const page = f.board.call(f.b.principal, "messages", {
      board_id: created.board_id,
      limit: 2,
    }) as { messages: Message[]; cursor: string };
    assert.equal(page.messages.length, 2);
    assert.ok(
      page.messages.every(
        (m) => m.board_id === created.board_id && m.deliveries!.length === 0,
      ),
    );
    const last = f.board.call(f.b.principal, "messages", {
      board_id: created.board_id,
      limit: 2,
      cursor: page.cursor,
    }) as { messages: Message[] };
    assert.equal(last.messages.length, 1);
    failure(
      () =>
        f.board.call(f.b.principal, "messages", {
          board_id: other.board_id,
          cursor: page.cursor,
        }),
      400,
    );
    const found = f.board.call(f.b.principal, "search", {
      board_id: created.board_id,
      query: "evidence",
      limit: 2,
    }) as { messages: Message[]; cursor: string };
    assert.equal(found.messages.length, 2);
    assert.ok(found.messages.every((m) => m.board_id === created.board_id));
    const thread = f.board.call(f.b.principal, "thread", {
      board_id: other.board_id,
      thread_id: "same-thread",
    }) as { messages: Message[] };
    assert.equal(thread.messages.length, 1);
    failure(
      () =>
        f.board.call(f.b.principal, "post", {
          board_id: other.board_id,
          thread_id: "same-thread",
          reply_to: page.messages[0]!.message_id,
          body: "cross-board reply",
          idempotency_key: key(),
        }),
      400,
    );
    const outsider = f.register(f.machine("private"), "other-scope");
    for (const method of ["messages", "search", "post"] as const) {
      const args =
        method === "messages"
          ? { board_id: created.board_id }
          : method === "search"
            ? { board_id: created.board_id, query: "evidence" }
            : {
                board_id: created.board_id,
                body: "not allowed",
                idempotency_key: key(),
              };
      failure(() => f.board.call(outsider.principal, method, args), 404);
    }
    failure(
      () =>
        f.board.call(outsider.principal, "boards", { cursor: first.cursor }),
      400,
    );
    const viewer = f.board.authenticate(
      f.board.issue(f.aMachine.principal, "viewer"),
    );
    failure(() => f.board.call(viewer, "create_board", input), 403);
    failure(
      () =>
        f.board.call(viewer, "post", {
          board_id: created.board_id,
          body: "write",
          idempotency_key: key(),
        }),
      403,
    );
  } finally {
    f.board.close();
  }
});

test("pagination moves both ways at any depth and binds board search and message order", () => {
  const f = fixture();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 27; i++) {
      const created = f.board.call(f.a.principal, "create_board", {
        name: `Release ${i}`,
        description: i === 0 ? "Literal 50%_done" : "Packaging",
        idempotency_key: key(),
      }) as { board_id: string };
      ids.push(created.board_id);
    }
    type BoardsPage = {
      boards: { board_id: string }[];
      cursor: string | null;
      previous_cursor: string | null;
    };
    const read = (cursor?: string) =>
      f.board.call(f.b.principal, "boards", {
        query: "Release",
        limit: 1,
        ...(cursor ? { cursor } : {}),
      }) as BoardsPage;
    let page = read();
    assert.equal(page.previous_cursor, null);
    for (const id of ids.toReversed()) {
      assert.equal(page.boards[0]!.board_id, id);
      if (page.cursor) page = read(page.cursor);
    }
    assert.equal(page.cursor, null);
    for (const id of ids) {
      assert.equal(page.boards[0]!.board_id, id);
      if (page.previous_cursor) page = read(page.previous_cursor);
    }
    assert.equal(page.previous_cursor, null);
    failure(
      () =>
        f.board.call(f.b.principal, "boards", {
          query: "different",
          cursor: page.cursor,
        }),
      400,
    );
    const escaped = f.board.call(f.b.principal, "boards", {
      query: "50%_done",
    }) as BoardsPage;
    assert.deepEqual(
      escaped.boards.map((b) => b.board_id),
      [ids[0]],
    );
    const messageIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const post = f.board.call(f.a.principal, "post", {
        board_id: ids[0],
        body: i === 0 ? "needle" : `needle and more words ${i}`,
        idempotency_key: key(),
      }) as { message_id: string };
      messageIds.push(post.message_id);
    }
    type MessagesPage = {
      messages: Message[];
      cursor: string | null;
      previous_cursor: string | null;
    };
    for (const method of ["messages", "search"] as const) {
      const args = {
        board_id: ids[0],
        limit: 3,
        ...(method === "search" ? { query: "needle", sort: "newest" } : {}),
      };
      const first = f.board.call(f.b.principal, method, args) as MessagesPage;
      assert.deepEqual(
        first.messages.map((m) => m.message_id),
        messageIds.slice(-3).toReversed(),
      );
      const second = f.board.call(f.b.principal, method, {
        ...args,
        cursor: first.cursor,
      }) as MessagesPage;
      const last = f.board.call(f.b.principal, method, {
        ...args,
        cursor: second.cursor,
      }) as MessagesPage;
      assert.equal(last.messages.length, 1);
      assert.equal(last.cursor, null);
      const back = f.board.call(f.b.principal, method, {
        ...args,
        cursor: last.previous_cursor,
      }) as MessagesPage;
      assert.deepEqual(back.messages, second.messages);
      assert.deepEqual(
        (
          f.board.call(f.b.principal, method, {
            ...args,
            cursor: back.previous_cursor,
          }) as MessagesPage
        ).messages,
        first.messages,
      );
      if (method === "search")
        failure(
          () =>
            f.board.call(f.b.principal, method, {
              ...args,
              sort: "relevance",
              cursor: first.cursor,
            }),
          400,
        );
    }
    type AuditPage = {
      events: { seq: number }[];
      cursor: string | null;
      previous_cursor: string | null;
    };
    const firstAudit = f.board.call(f.b.principal, "audit", {
      limit: 2,
    }) as AuditPage;
    const nextAudit = f.board.call(f.b.principal, "audit", {
      limit: 2,
      cursor: firstAudit.cursor,
    }) as AuditPage;
    assert.ok(nextAudit.events[0]!.seq > firstAudit.events[1]!.seq);
    assert.deepEqual(
      (
        f.board.call(f.b.principal, "audit", {
          limit: 2,
          cursor: nextAudit.previous_cursor,
        }) as AuditPage
      ).events,
      firstAudit.events,
    );
  } finally {
    f.board.close();
  }
});

test("v1 history migrates transactionally into General and keeps IDs, search, deliveries and credentials", () => {
  mkdirSync("work", { recursive: true });
  const dir = mkdtempSync(resolve("work/board-migration-"));
  const path = join(dir, "data.db");
  const f = fixture(path);
  const m = f.send();
  // Recreate the exact v1 message schema from the fixture, preserving all v1 rows.
  f.board.db.exec(
    "DROP TRIGGER messages_board_scope; DROP INDEX messages_board; ALTER TABLE messages DROP COLUMN board_id; DROP TABLE boards; PRAGMA user_version=1;",
  );
  f.board.close();
  const upgraded = new Board(path);
  try {
    const principal = upgraded.authenticate(f.b.token);
    const boards = upgraded.call(principal, "boards", {}) as {
      boards: { board_id: string; name: string }[];
    };
    assert.equal(boards.boards.length, 1);
    assert.equal(boards.boards[0]!.name, "General");
    const history = upgraded.call(principal, "messages", {
      board_id: boards.boards[0]!.board_id,
      pending: true,
    }) as { messages: Message[] };
    assert.equal(history.messages[0]!.message_id, m.message_id);
    assert.equal(
      history.messages[0]!.deliveries![0]!.state,
      "accepted_by_board",
    );
    const found = upgraded.call(principal, "search", {
      board_id: boards.boards[0]!.board_id,
      query: "sqlite",
    }) as { messages: Message[] };
    assert.equal(found.messages[0]!.message_id, m.message_id);
    assert.equal(
      upgraded.one<{ user_version: number }>("PRAGMA user_version")!
        .user_version,
      2,
    );
    upgraded.close();
    const reopened = new Board(path);
    try {
      assert.deepEqual(
        reopened.call(reopened.authenticate(f.b.token), "boards", {}),
        boards,
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (upgraded.db.isOpen) upgraded.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable send, strict sender binding, replay conflict and explicit acknowledgements", () => {
  const f = fixture();
  const idempotency = key();
  const m = f.send(undefined, undefined, undefined, idempotency);
  assert.equal(m.state, "accepted_by_board");
  assert.deepEqual(f.send(undefined, undefined, undefined, idempotency), m);
  failure(
    () => f.send(undefined, undefined, "Different input", idempotency),
    409,
  );
  failure(
    () =>
      f.board.call(f.a.principal, "send", {
        from_session_id: f.b.session_id,
        to: f.b.session_id,
        body: "spoof",
        thread_id: "x",
        idempotency_key: key(),
      }),
    400,
  );
  failure(
    () =>
      f.board.call(f.a.principal, "ack", {
        message_id: m.message_id,
        acknowledgement: "completed",
        idempotency_key: key(),
      }),
    403,
  );
  f.board.call(f.b.principal, "ack", {
    message_id: m.message_id,
    acknowledgement: "received",
    idempotency_key: key(),
  });
  f.board.call(f.b.principal, "ack", {
    message_id: m.message_id,
    acknowledgement: "completed",
    idempotency_key: key(),
  });
  failure(
    () =>
      f.board.call(f.b.principal, "ack", {
        message_id: m.message_id,
        acknowledgement: "received",
        idempotency_key: key(),
      }),
    409,
  );
  const pending = f.board.call(f.b.principal, "messages", {
    pending: true,
  }) as { messages: Message[] };
  assert.equal(pending.messages.length, 0);
  f.board.close();
});

test("project boundary applies to discovery, send, search, vector search, thread, ack and cursors", () => {
  const f = fixture();
  const outsider = f.register(f.machine("private"), "secret");
  const m = f.send();
  f.send(undefined, undefined, "Another search message");
  for (const method of ["messages", "sessions", "thread", "search"] as const) {
    const result = f.board.call(
      outsider.principal,
      method,
      method === "search"
        ? { query: "SQLite" }
        : method === "thread"
          ? { thread_id: "build" }
          : {},
    ) as { messages?: unknown[]; sessions?: unknown[] };
    assert.equal(
      (result.messages ?? result.sessions)!.length,
      method === "sessions" ? 1 : 0,
    );
  }
  failure(() => f.send(outsider.principal, f.b.session_id), 404);
  failure(
    () =>
      f.board.call(outsider.principal, "ack", {
        message_id: m.message_id,
        acknowledgement: "received",
        idempotency_key: key(),
      }),
    404,
  );
  const page = f.board.call(f.a.principal, "messages", { limit: 1 }) as {
    cursor: string;
  };
  failure(
    () =>
      f.board.call(outsider.principal, "messages", {
        cursor: page.cursor,
        limit: 1,
      }),
    400,
  );
  f.board.call(f.a.principal, "embed", {
    message_id: m.message_id,
    model: "demo-v1",
    vector: [1, 0],
    idempotency_key: key(),
  });
  const semantic = f.board.call(outsider.principal, "search", {
    model: "demo-v1",
    vector: [1, 0],
  }) as { messages: unknown[] };
  assert.equal(semantic.messages.length, 0);
  f.board.close();
});

test("registration survives restart, aliases fail ambiguously, viewer cannot mutate", () => {
  const f = fixture();
  const native = key();
  const first = f.register(f.aMachine, "duplicate", native);
  const second = f.register(f.aMachine, "duplicate", native);
  assert.equal(first.session_id, second.session_id);
  assert.equal(first.token, second.token);
  f.register(f.bMachine, "duplicate");
  failure(() => f.send(undefined, "duplicate"), 409);
  const viewer = f.board.authenticate(f.board.issue(f.a.principal, "viewer"));
  failure(() => f.send(viewer), 403);
  failure(
    () =>
      f.board.call(f.bMachine.principal, "heartbeat", {
        session_id: f.a.session_id,
      }),
    403,
  );
  f.board.close();
});

test("full-text prefix, Unicode, punctuation, ranking and cursor filters remain safe", () => {
  const f = fixture();
  f.send(undefined, undefined, "Café renderer fixes SQLite fulltext search.");
  f.send(undefined, undefined, "SQLite backup ready.");
  const search = (query: string) =>
    f.board.call(f.a.principal, "search", { query }) as { messages: Message[] };
  assert.equal(search("cafe rend").messages.length, 1);
  assert.equal(search("SQLITE").messages.length, 2);
  assert.equal(search('" OR *').messages.length, 0);
  assert.equal(search("...").messages.length, 0);
  const first = f.board.call(f.a.principal, "search", {
    query: "sqlite",
    limit: 1,
  }) as { messages: Message[]; cursor: string };
  const second = f.board.call(f.a.principal, "search", {
    query: "sqlite",
    limit: 1,
    cursor: first.cursor,
  }) as { messages: Message[] };
  assert.notEqual(
    first.messages[0]!.message_id,
    second.messages[0]!.message_id,
  );
  failure(
    () =>
      f.board.call(f.a.principal, "search", {
        query: "other",
        cursor: first.cursor,
      }),
    400,
  );
  f.board.close();
});

test("embeddings are author-owned, dimension-checked, scoped by model and normalized safely", () => {
  const f = fixture();
  const a = f.send();
  const b = f.send(undefined, undefined, "Installer bug");
  const embed = (
    p: Principal,
    message_id: string,
    vector: number[],
    model = "test-v1",
  ) =>
    f.board.call(p, "embed", {
      message_id,
      model,
      vector,
      idempotency_key: key(),
    });
  failure(() => embed(f.b.principal, a.message_id, [1, 0]), 403);
  failure(() => embed(f.a.principal, a.message_id, [0, 0]), 400);
  failure(() => embed(f.a.principal, a.message_id, [Infinity]), 400);
  embed(f.a.principal, a.message_id, [1e308, 0]);
  embed(f.a.principal, b.message_id, [0, 1]);
  failure(() => embed(f.a.principal, a.message_id, [1, 2, 3]), 409);
  const found = f.board.call(f.a.principal, "search", {
    model: "test-v1",
    vector: [1, 0],
  }) as { messages: Message[] };
  assert.equal(found.messages[0]!.message_id, a.message_id);
  assert.equal(found.messages[0]!.score, 1);
  assert.equal(found.messages[1]!.score, 0);
  failure(
    () =>
      f.board.call(f.a.principal, "search", { model: "test-v1", vector: [1] }),
    400,
  );
  f.board.close();
});

test("offline leases recover without false receipt and stale workers cannot report", () => {
  const f = fixture();
  const receiver = f.register(f.bMachine, "queue", key(), "codex-queue");
  assert.equal(receiver.capability, "QUEUED");
  const m = f.send(undefined, receiver.session_id);
  const claim = () =>
    f.board.call(f.bMachine.principal, "claim", {
      session_id: receiver.session_id,
    }) as { deliveries: Claimed[] };
  const first = claim().deliveries[0]!;
  assert.equal(first.message_id, m.message_id);
  assert.equal(claim().deliveries.length, 0);
  f.advance(61000);
  const recovered = claim().deliveries[0]!;
  assert.notEqual(first.lease_id, recovered.lease_id);
  const report = (lease_id: string) =>
    f.board.call(f.bMachine.principal, "report", {
      message_id: m.message_id,
      session_id: receiver.session_id,
      lease_id,
      state: "queued_with_provider",
    });
  failure(() => report(first.lease_id), 409);
  report(recovered.lease_id);
  f.advance(900000);
  assert.equal(claim().deliveries.length, 0);
  const d = f.board.one<{ acknowledgement: null; state: string }>(
    "SELECT * FROM deliveries WHERE message_id=?",
    m.message_id,
  )!;
  assert.equal(d.acknowledgement, null);
  assert.equal(d.state, "queued_with_provider");
  f.board.close();
});

test("Windows queue capability is limited to the verified CLI version and runtime", () => {
  const f = fixture();
  try {
    for (const [os, runtime_id, provider_version, expected] of [
      ["win32", "cli", "codex-cli 0.157.1", "QUEUED"],
      ["win32", "desktop", "codex-cli 0.157.1", "MAILBOX"],
      ["win32", "cli", "codex-cli 0.141.0", "MAILBOX"],
      ["win32", "cli", "codex-cli 0.158.0-alpha.1", "MAILBOX"],
      ["linux", "cli", "codex-cli 0.157.1", "MAILBOX"],
    ]) {
      const result = f.board.call(
        f.aMachine.principal,
        "register",
        {
          native_session_id: key(),
          provider: "codex",
          provider_version,
          runtime_id,
          alias: "capability-test",
          os,
          transport: "codex-queue",
        },
        f.aMachine.token,
      ) as { capability: string };
      assert.equal(
        result.capability,
        expected,
        `${os}/${runtime_id}/${provider_version}`,
      );
    }
  } finally {
    f.board.close();
  }
});

test("unverified transports stay mailbox and presence cannot infer model activity", () => {
  const f = fixture();
  const result = f.board.call(
    f.aMachine.principal,
    "register",
    {
      native_session_id: key(),
      provider: "claude-code",
      provider_version: "2.1.283",
      alias: "desktop",
      os: "darwin",
      runtime_id: "desktop",
      transport: "claude-channel",
    },
    f.aMachine.token,
  ) as { capability: string };
  assert.equal(result.capability, "MAILBOX");
  f.board.call(f.a.principal, "status", {
    state: "working",
    idempotency_key: key(),
  });
  f.advance(121000);
  const list = f.board.call(f.a.principal, "sessions", {}) as {
    sessions: { connection: string; state: string }[];
  };
  assert.ok(
    list.sessions.every(
      (s) => s.state === "unknown" && s.connection === "offline",
    ),
  );
  f.board.close();
});

test("database reopen keeps messages, search index, idempotency and embeddings", () => {
  mkdirSync(resolve("work"), { recursive: true });
  const dir = mkdtempSync(resolve("work/db-test-"));
  const path = join(dir, "data.db");
  const f = fixture(path);
  const idempotency = key();
  const m = f.send(undefined, undefined, undefined, idempotency);
  f.board.call(f.a.principal, "embed", {
    message_id: m.message_id,
    model: "v1",
    vector: [1, 2],
    idempotency_key: key(),
  });
  f.board.close();
  const reopened = new Board(path);
  const principal = reopened.authenticate(f.a.token);
  const search = reopened.call(principal, "search", { query: "SQLite" }) as {
    messages: Message[];
  };
  assert.equal(search.messages[0]!.message_id, m.message_id);
  assert.equal(search.messages[0]!.embedding_count, 1);
  const repeat = reopened.call(principal, "send", {
    to: f.b.session_id,
    body: "Please verify SQLite search on Windows.",
    thread_id: "build",
    idempotency_key: idempotency,
  });
  assert.deepEqual(repeat, m);
  reopened.close();
  rmSync(dir, { recursive: true });
});

test("HTTP authorization, request limits, browser origins, TLS rule and machine revocation", async () => {
  const f = fixture();
  const service = await serve(f.board, { port: 0 });
  const url = `http://127.0.0.1:${service.port}`;
  const client = new Client(url, f.a.token);
  try {
    assert.equal((await fetch(`${url}/health`)).status, 401);
    assert.equal(
      (
        await fetch(`${url}/health`, {
          headers: {
            authorization: `Bearer ${f.a.token}`,
            origin: "https://evil.example",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${url}/api/send`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.a.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ body: "x".repeat(140000) }),
        })
      ).status,
      413,
    );
    await assert.rejects(serve(f.board, { host: "0.0.0.0", port: 0 }), /TLS/);
    await client.call("sessions", {});
    f.board.run(
      "UPDATE credentials SET revoked=1 WHERE id=?",
      f.aMachine.principal.id,
    );
    await assert.rejects(
      client.call("sessions", {}),
      (e) => e instanceof BoardError && e.status === 401,
    );
  } finally {
    await service.close();
    f.board.close();
  }
});

test("adapter persists recipient spool and recovers a provider receipt after lost server report", async () => {
  const f = fixture();
  const r = f.register(f.bMachine, "queue", key(), "codex-queue");
  const m = f.send(undefined, r.session_id);
  const service = await serve(f.board, { port: 0 });
  const spool = new Board(":memory:");
  const client = new Client(
    `http://127.0.0.1:${service.port}`,
    f.bMachine.token,
  );
  spool.run(
    "INSERT INTO spool VALUES (?,?,?,?,?,?)",
    client.url,
    r.session_id,
    m.message_id,
    "{}",
    "queued_with_provider",
    Date.now(),
  );
  let delivered = 0;
  const adapter = new Adapter(
    client,
    spool,
    r.session_id,
    "codex-queue",
    async () => {
      delivered++;
    },
  );
  try {
    await adapter.tick();
    assert.equal(delivered, 0);
    assert.equal(
      f.board.one<{ state: string }>(
        "SELECT state FROM deliveries WHERE message_id=?",
        m.message_id,
      )!.state,
      "queued_with_provider",
    );
  } finally {
    await adapter.stop();
    await service.close();
    spool.close();
    f.board.close();
  }
});
