import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../store.js";
import { BoardError } from "../types.js";
import type { Launch } from "../lifecycle.js";
import {
  HostJournal,
  inside,
  nativeEvent,
  prepareWorktree,
  providerArguments,
  workerEnvironment,
} from "../host.js";
import { Client } from "../client.js";

function fixture() {
  let now = Date.now();
  const board = new Board(":memory:", () => now);
  const machine = (project = "app") => {
    const token = board.issue(
      { workspace_id: "test", project_id: project, machine_id: randomUUID() },
      "machine",
    );
    return { token, principal: board.authenticate(token) };
  };
  const owner = machine(),
    other = machine(),
    outsider = machine("other");
  const register = (m: typeof owner, role = "worker") => {
    const r = board.call(
      m.principal,
      "register",
      {
        native_session_id: randomUUID(),
        provider: "codex",
        provider_version: "codex-cli 0.159.2",
        runtime_id: "cli",
        alias: randomUUID(),
        os: "win32",
        role,
      },
      m.token,
    ) as { session_id: string; token: string };
    return { ...r, principal: board.authenticate(r.token) };
  };
  const coordinator = register(owner, "coordinator"),
    worker = register(owner, "coordinator");
  const hostId = randomUUID();
  const enrollment = {
    host_id: hostId,
    name: "Maxis",
    os: "win32",
    providers: [
      { provider: "codex", version: "codex-cli 0.159.2", mode: "headless" },
    ],
    repositories: ["project"],
    coordinators: [coordinator.session_id],
    authorization_expires_at: now + 3600000,
    idempotency_key: randomUUID(),
  };
  const enroll = (overrides: Record<string, unknown> = {}) => {
    const target = (overrides.host_id ?? hostId) as string;
    board.call(
      owner.principal,
      "register",
      {
        native_session_id: `host:${target}`,
        provider: "other",
        provider_version: "1",
        runtime_id: "host-service",
        alias: `host-${target}`,
        os: "win32",
      },
      owner.token,
    );
    return board.call(owner.principal, "host_register", {
      ...enrollment,
      ...overrides,
      idempotency_key: randomUUID(),
    });
  };
  enroll();
  const request = (p = coordinator.principal, overrides = {}) =>
    board.call(p, "start_session", {
      host_id: hostId,
      provider: "codex",
      mode: "headless",
      repository: "project",
      base_sha: "a".repeat(40),
      assignment_id: "bounded-check",
      objective: "Verify the bounded check",
      criteria: "Report one result",
      idempotency_key: randomUUID(),
      ...overrides,
    }) as { launch_id: string };
  const claim = (p = owner.principal) =>
    (
      board.call(p, "claim_launch", { host_id: hostId }) as {
        launches: Launch[];
      }
    ).launches;
  const report = (job: Launch, state: string, extra = {}) =>
    board.call(owner.principal, "report_launch", {
      host_id: hostId,
      launch_id: job.launch_id,
      lease_id: job.lease_id,
      state,
      idempotency_key: randomUUID(),
      ...extra,
    });
  return {
    board,
    owner,
    other,
    outsider,
    coordinator,
    worker,
    hostId,
    enroll,
    request,
    claim,
    report,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const rejected = (fn: () => unknown, status: number) =>
  assert.throws(fn, (e) => e instanceof BoardError && e.status === status);

test("only the exact authorized coordinator can create a bounded native launch", () => {
  const f = fixture();
  try {
    rejected(() => f.request(f.worker.principal), 403); // Same role label grants nothing.
    rejected(() => f.request(f.owner.principal), 403);
    rejected(
      () => f.request(f.coordinator.principal, { repository: "../../escape" }),
      403,
    );
    rejected(
      () => f.request(f.coordinator.principal, { provider: "claude-code" }),
      400,
    );
    rejected(
      () =>
        f.board.call(f.other.principal, "host_register", { host_id: f.hostId }),
      400,
    );
    const key = randomUUID(),
      first = f.request(undefined, { idempotency_key: key });
    assert.deepEqual(f.request(undefined, { idempotency_key: key }), first);
    rejected(
      () =>
        f.request(undefined, {
          idempotency_key: key,
          objective: "Different work",
        }),
      409,
    );
    rejected(() => f.claim(f.other.principal), 403);
    rejected(() => f.claim(f.outsider.principal), 404);
    assert.equal(f.claim()[0]!.attempts, 1);
    assert.equal(f.claim().length, 0);
  } finally {
    f.board.close();
  }
});

test("revocation, expiry and repository/provider removal fence the final spawn transition", () => {
  for (const cause of [
    "expiry",
    "credential",
    "owner",
    "repository",
    "provider",
  ]) {
    const f = fixture();
    try {
      f.request();
      const job = f.claim()[0]!;
      if (cause === "expiry") f.advance(3600001);
      if (cause === "credential")
        f.board.run(
          "UPDATE credentials SET revoked=1 WHERE id=?",
          f.coordinator.principal.id,
        );
      if (cause === "owner")
        f.board.run(
          "UPDATE credentials SET revoked=1 WHERE id=?",
          f.owner.principal.id,
        );
      if (cause === "repository") f.enroll({ repositories: ["another"] });
      if (cause === "provider")
        f.enroll({
          providers: [
            { provider: "claude-code", version: "2.1.308", mode: "headless" },
          ],
        });
      rejected(
        () => f.report(job, "launching"),
        cause === "expiry" ? 409 : 403,
      );
      assert.equal(
        f.board.one<{ state: string }>(
          "SELECT state FROM lifecycle_launches WHERE launch_id=?",
          job.launch_id,
        )!.state,
        "claimed",
      );
    } finally {
      f.board.close();
    }
  }
});

test("expired unstarted claims can recover, native effects cannot be blindly reclaimed", () => {
  const f = fixture();
  try {
    f.request();
    const first = f.claim()[0]!;
    f.advance(60001);
    const second = f.claim()[0]!;
    assert.notEqual(first.lease_id, second.lease_id);
    assert.equal(second.attempts, 2);
    rejected(() => f.report(first, "launching"), 409);
    f.report(second, "launching");
    f.advance(60001);
    assert.equal(f.claim().length, 0);
    f.report(second, "uncertain");
    f.request();
    assert.equal(f.claim().length, 0);
  } finally {
    f.board.close();
  }
});

test("native identity and assistant nonce are mandatory before completion", () => {
  const f = fixture();
  try {
    f.request();
    const job = f.claim()[0]!,
      native = randomUUID();
    f.report(job, "launching");
    rejected(() => f.report(job, "native_created"), 400);
    f.report(job, "native_created", { native_session_id: native });
    rejected(
      () =>
        f.report(job, "ready", {
          native_session_id: randomUUID(),
          acknowledgement_nonce: job.nonce,
          ack_source: "native_assistant_output",
        }),
      409,
    );
    rejected(
      () =>
        f.report(job, "ready", {
          acknowledgement_nonce: "echo",
          ack_source: "native_assistant_output",
        }),
      400,
    );
    rejected(() => f.report(job, "completed"), 409);
    f.report(job, "ready", {
      acknowledgement_nonce: job.nonce,
      ack_source: "native_assistant_output",
    });
    f.report(job, "completed", { result: "Verified result" });
    rejected(() => f.report(job, "uncertain"), 409);
    const own = f.board.call(f.coordinator.principal, "launches", {}) as {
      launches: Record<string, unknown>[];
    };
    assert.equal(own.launches[0]!.ack_source, "native_assistant_output");
    for (const field of [
      "objective",
      "criteria",
      "nonce",
      "lease_id",
      "requester_id",
    ])
      assert.equal(field in own.launches[0]!, false);
    assert.equal(
      (
        f.board.call(f.worker.principal, "launches", {}) as {
          launches: unknown[];
        }
      ).launches.length,
      0,
    );
  } finally {
    f.board.close();
  }
});

test("host provider filter is applied before bounded signed-cursor pagination", () => {
  const f = fixture();
  try {
    f.enroll({
      host_id: randomUUID(),
      providers: [
        { provider: "claude-code", version: "2.1.308", mode: "headless" },
      ],
    });
    f.enroll({ host_id: randomUUID() });
    const first = f.board.call(f.coordinator.principal, "hosts", {
      provider: "codex",
      limit: 1,
    }) as { hosts: unknown[]; cursor: string };
    const next = f.board.call(f.coordinator.principal, "hosts", {
      provider: "codex",
      limit: 1,
      cursor: first.cursor,
    }) as { hosts: unknown[]; cursor: string | null };
    assert.equal(first.hosts.length, 1);
    assert.equal(next.hosts.length, 1);
    assert.equal(next.cursor, null);
    rejected(
      () =>
        f.board.call(f.coordinator.principal, "hosts", {
          provider: "claude-code",
          limit: 1,
          cursor: first.cursor,
        }),
      400,
    );
  } finally {
    f.board.close();
  }
});

test("provider parsing separates real assistant output from echoed requests and IDs", () => {
  assert.deepEqual(
    nativeEvent("codex", {
      type: "item.completed",
      item: { type: "command_execution", text: "CB_READY_fake" },
    }),
    { done: false, failed: false },
  );
  assert.deepEqual(
    nativeEvent("claude-code", {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "CB_READY_fake" }],
      },
    }),
    { done: false, failed: false },
  );
  assert.equal(
    nativeEvent("codex", {
      type: "item.completed",
      item: { type: "agent_message", text: "CB_READY_real" },
    }).assistant,
    "CB_READY_real",
  );
  assert.equal(
    nativeEvent("claude-code", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "CB_READY_real" }],
      },
    }).assistant,
    "CB_READY_real",
  );
  const env = workerEnvironment({
    PATH: "native",
    CODEX_THREAD_ID: "parent",
    CLAUDE_SESSION_ID: "parent",
    CLAUDE_CODE_SESSION_ID: "parent",
    CHATTERBOX_TOKEN: "secret",
  });
  assert.deepEqual(env, { PATH: "native" });
  for (const provider of ["codex", "claude-code"] as const) {
    const args = providerArguments(
      provider,
      "owned-worktree",
      randomUUID(),
    ).join(" ");
    assert.doesNotMatch(
      args,
      /resume|continue|dangerously|bypass|--model|--bare/,
    );
  }
});

test("host journal fences a crash after spawn and delivers terminal notice once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chatterbox-host-journal-"));
  const f = fixture();
  f.request();
  const job = f.claim()[0]!;
  let journal = new HostJournal(directory);
  try {
    assert.throws(() => new HostJournal(directory));
    journal.attempt(job);
    journal.phase(job.launch_id, "spawn_attempted");
    journal.close();
    journal = new HostJournal(directory);
    journal.recover();
    assert.throws(() => journal.attempt(job), /reconciliation/);
    const reports: unknown[] = [],
      notices: unknown[] = [];
    const fake = {
      call: async (_method: string, payload: unknown) => {
        reports.push(payload);
        return {};
      },
    } as unknown as Client;
    const agent = {
      call: async (_method: string, payload: unknown) => {
        notices.push(payload);
        return {};
      },
    } as unknown as Client;
    await journal.notify(agent);
    assert.equal(notices.length, 0);
    await journal.flush(fake);
    await journal.notify(agent);
    await journal.flush(fake);
    await journal.notify(agent);
    assert.equal(reports.length, 1);
    assert.equal((reports[0] as { state: string }).state, "uncertain");
    assert.equal(notices.length, 1);
  } finally {
    journal.close();
    f.board.close();
  }
});

test("canonical worktree containment rejects path and junction escapes", async () => {
  assert.equal(inside("/approved", "/approved-extra/child"), false);
  assert.equal(inside("/approved", "/approved"), false);
  const directory = mkdtempSync(join(tmpdir(), "chatterbox-host-path-"));
  const outside = mkdtempSync(join(tmpdir(), "chatterbox-host-outside-"));
  const link = join(directory, "link");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(inside(realpathSync(directory), realpathSync(link)), false);
  const f = fixture();
  try {
    f.request();
    const job = f.claim()[0]!;
    mkdirSync(join(directory, "not-a-repo"));
    await assert.rejects(prepareWorktree(join(directory, "not-a-repo"), job));
  } finally {
    f.board.close();
  }
});

test("terminal report and notice commit atomically and rejected terminal evidence cannot announce success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chatterbox-host-atomic-"));
  const f = fixture();
  f.request();
  const job = f.claim()[0]!;
  let journal = new HostJournal(directory);
  try {
    journal.attempt(job);
    journal.db.exec(
      "CREATE TRIGGER fail_notice BEFORE INSERT ON notices BEGIN SELECT RAISE(ABORT,'injected crash boundary'); END",
    );
    assert.throws(
      () =>
        journal.enqueue(job, "completed", {
          native_session_id: randomUUID(),
          result: "Result",
        }),
      /injected/,
    );
    assert.equal(
      journal.db.prepare("SELECT count(*) AS n FROM outbox").get()!.n,
      0,
    );
    journal.db.exec("DROP TRIGGER fail_notice");
    journal.enqueue(job, "completed", {
      native_session_id: randomUUID(),
      result: "Result",
    });
    // Simulate a journal created by the earlier non-atomic implementation.
    journal.db.prepare("DELETE FROM notices").run();
    journal.close();
    journal = new HostJournal(directory);
    journal.recover();
    assert.equal(
      journal.db.prepare("SELECT count(*) AS n FROM notices").get()!.n,
      1,
    );
    const rejectedClient = {
      call: async () => {
        throw new BoardError(409, "Native evidence rejected");
      },
    } as unknown as Client;
    await assert.rejects(journal.flush(rejectedClient));
    const notices: Record<string, unknown>[] = [];
    const agent = {
      call: async (_method: string, payload: Record<string, unknown>) => {
        notices.push(payload);
        return {};
      },
    } as unknown as Client;
    await journal.notify(agent);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.kind, "blocker");
    assert.match(notices[0]!.body as string, /rejected.*completed/);
    await journal.notify(agent);
    assert.equal(notices.length, 1);
  } finally {
    journal.close();
    f.board.close();
  }
});

test("authorization rejection during claim durably notifies the exact coordinator once", () => {
  const f = fixture();
  try {
    const requested = f.request();
    f.advance(3600001);
    assert.deepEqual(f.claim(), []);
    assert.equal(
      f.board.one<{ state: string }>(
        "SELECT state FROM lifecycle_launches WHERE launch_id=?",
        requested.launch_id,
      )!.state,
      "failed",
    );
    assert.equal(
      f.board.one<{ n: number }>(
        "SELECT count(*) AS n FROM messages WHERE thread_id=?",
        `launch:${requested.launch_id}`,
      )!.n,
      1,
    );
    assert.equal(
      f.board.one<{ to_session_id: string }>(
        "SELECT to_session_id FROM deliveries d JOIN messages m ON m.message_id=d.message_id WHERE thread_id=?",
        `launch:${requested.launch_id}`,
      )!.to_session_id,
      f.coordinator.session_id,
    );
    assert.deepEqual(f.claim(), []);
    assert.equal(
      f.board.one<{ n: number }>(
        "SELECT count(*) AS n FROM messages WHERE thread_id=?",
        `launch:${requested.launch_id}`,
      )!.n,
      1,
    );
  } finally {
    f.board.close();
  }
});

test("readiness wait followed by ready and restart emits a distinct crash blocker", async () => {
  const f = fixture(),
    directory = mkdtempSync(join(tmpdir(), "chatterbox-host-wait-recovery-"));
  f.request();
  const job = f.claim()[0]!,
    native = randomUUID();
  let journal = new HostJournal(directory);
  const client = {
    call: async (method: "report_launch", payload: unknown) =>
      f.board.call(f.owner.principal, method, payload),
  } as unknown as Client;
  const notices: Record<string, unknown>[] = [];
  const agent = {
    call: async (_method: string, payload: Record<string, unknown>) => {
      notices.push(payload);
      return {};
    },
  } as unknown as Client;
  try {
    journal.attempt(job);
    journal.enqueue(job, "launching");
    await journal.flush(client);
    journal.phase(job.launch_id, "spawn_attempted");
    journal.enqueue(job, "waiting", {
      detail: "Readiness pending after deadline",
    });
    journal.phase(job.launch_id, "waiting");
    await journal.flush(client);
    await journal.notify(agent);
    assert.equal(notices.length, 1);
    journal.enqueue(job, "native_created", { native_session_id: native });
    journal.enqueue(job, "ready", {
      native_session_id: native,
      acknowledgement_nonce: job.nonce,
      ack_source: "native_assistant_output",
    });
    journal.phase(job.launch_id, "ready", native);
    await journal.flush(client);
    journal.close();
    journal = new HostJournal(directory);
    journal.recover();
    await journal.flush(client);
    await journal.notify(agent);
    assert.equal(
      f.board.one<{ state: string }>(
        "SELECT state FROM lifecycle_launches WHERE launch_id=?",
        job.launch_id,
      )!.state,
      "uncertain",
    );
    assert.equal(notices.length, 2);
    assert.match(notices[1]!.body as string, /uncertain/);
    await journal.notify(agent);
    assert.equal(notices.length, 2);
  } finally {
    journal.close();
    f.board.close();
  }
});

test("an approved bare repository creates an isolated worker worktree at its exact base", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chatterbox-host-bare-"));
  execFileSync("git", ["init", "--bare", "--object-format=sha1", directory], {
    stdio: "ignore",
  });
  const tree = execFileSync("git", ["-C", directory, "mktree"], {
    input: "",
    encoding: "utf8",
  }).trim();
  const commit = execFileSync(
    "git",
    [
      "-C",
      directory,
      "-c",
      "user.name=Host test",
      "-c",
      "user.email=host-test@example.invalid",
      "commit-tree",
      tree,
      "-m",
      "Host fixture",
    ],
    { encoding: "utf8" },
  ).trim();
  const f = fixture();
  try {
    f.request(undefined, { base_sha: commit });
    const job = f.claim()[0]!;
    // Git and Node can preserve different drive-letter casing on Windows.
    const approved = directory.replace(/^[A-Z]:/, (drive) =>
      drive.toLowerCase(),
    );
    const worktree = await prepareWorktree(approved, job);
    assert.equal(
      inside(realpathSync.native(directory), realpathSync.native(worktree)),
      true,
    );
    assert.equal(
      execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      commit,
    );
    assert.equal(
      execFileSync("git", ["-C", worktree, "status", "--porcelain"], {
        encoding: "utf8",
      }).trim(),
      "",
    );
  } finally {
    f.board.close();
  }
});
