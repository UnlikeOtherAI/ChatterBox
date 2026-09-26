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
