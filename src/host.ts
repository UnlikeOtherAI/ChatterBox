import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  openSync,
  closeSync,
  readSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { Client } from "./client.js";
import { readConfig } from "./config.js";
import type { Launch } from "./lifecycle.js";
import { BoardError } from "./errors.js";

const providerName = z.enum(["codex", "claude-code"]);
export const hostConfigSchema = z
  .object({
    host_id: z.uuid(),
    name: z.string().min(1).max(120),
    connection: z.string().min(1),
    state_directory: z.string().min(1),
    coordinators: z.array(z.string().min(1)).min(1).max(16),
    authorization_expires_at: z.number().int().positive(),
    repositories: z.record(z.string().min(1).max(120), z.string().min(1)),
    providers: z
      .array(
        z
          .object({
            provider: providerName,
            executable: z.string().min(1),
            proof: z.string().max(200).default("unverified"),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();
export type HostConfig = z.infer<typeof hostConfigSchema>;

/** Child identities must come from their own native output, never this process. */
export function workerEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([k]) =>
        !/^(CHATTERBOX_|CODEX_THREAD_ID$|CLAUDE_CODE_SESSION_ID$|CLAUDE_SESSION_ID$|ELECTRON_RUN_AS_NODE$)/i.test(
          k,
        ),
    ),
  );
}
export function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}
export function providerArguments(
  provider: "codex" | "claude-code",
  worktree: string,
  nativeId: string,
) {
  return provider === "codex"
    ? [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--cd",
        worktree,
        "-c",
        "mcp_servers.chatterbox.enabled=false",
        "-",
      ]
    : [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--session-id",
        nativeId,
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
      ];
}

export type NativeEvent = {
  nativeId?: string;
  assistant?: string;
  done?: boolean;
  failed?: boolean;
};
/** Only provider assistant messages can acknowledge an assignment. Input echoes cannot. */
export function nativeEvent(
  provider: "codex" | "claude-code",
  input: unknown,
): NativeEvent {
  if (!input || typeof input !== "object") return {};
  const e = input as Record<string, unknown>;
  if (provider === "codex") {
    if (e.type === "thread.started")
      return {
        nativeId: typeof e.thread_id === "string" ? e.thread_id : undefined,
      };
    if (e.type === "item.completed" && e.item && typeof e.item === "object") {
      const item = e.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string")
        return { assistant: item.text };
    }
    return {
      done: e.type === "turn.completed",
      failed: e.type === "turn.failed" || e.type === "error",
    };
  }
  if (e.type === "system" && e.subtype === "init")
    return {
      nativeId: typeof e.session_id === "string" ? e.session_id : undefined,
    };
  if (e.type === "assistant" && e.message && typeof e.message === "object") {
    const message = e.message as Record<string, unknown>;
    if (message.role !== "assistant" || !Array.isArray(message.content))
      return {};
    return {
      assistant: message.content
        .filter(
          (v) =>
            v &&
            typeof v === "object" &&
            v.type === "text" &&
            typeof v.text === "string",
        )
        .map((v) => v.text)
        .join("\n"),
    };
  }
  return {
    done: e.type === "result" && e.is_error === false,
    failed: e.type === "result" && e.is_error === true,
  };
}

export class HostJournal {
  private lock: DatabaseSync;
  private flushing?: Promise<void>;
  db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = new DatabaseSync(join(directory, "host-lock.db"));
    try {
      this.lock.exec(
        "CREATE TABLE IF NOT EXISTS singleton(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE; INSERT OR IGNORE INTO singleton VALUES (1)",
      );
    } catch (error) {
      this.lock.close();
      throw error;
    }
    this.db = new DatabaseSync(join(directory, "host-journal.db"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS attempts(launch_id TEXT PRIMARY KEY,job TEXT NOT NULL,phase TEXT NOT NULL,native_id TEXT,pid INTEGER,worktree TEXT); CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,launch_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,UNIQUE(launch_id,state))",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS notices(launch_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(launch_id,state))",
    );
  }
  attempt(job: Launch) {
    const old = this.db
      .prepare("SELECT phase FROM attempts WHERE launch_id=?")
      .get(job.launch_id);
    if (old && old.phase !== "prepared")
      throw new Error(
        "Existing native launch attempt requires reconciliation; spawning again is forbidden",
      );
    this.db
      .prepare(
        "INSERT INTO attempts(launch_id,job,phase) VALUES (?,?,'prepared') ON CONFLICT(launch_id) DO UPDATE SET job=excluded.job",
      )
      .run(job.launch_id, JSON.stringify(job));
  }
  phase(launchId: string, phase: string, nativeId?: string) {
    this.db
      .prepare(
        "UPDATE attempts SET phase=?,native_id=coalesce(?,native_id) WHERE launch_id=?",
      )
      .run(phase, nativeId ?? null, launchId);
  }
  process(launchId: string, pid: number | undefined, worktree: string) {
    this.db
      .prepare("UPDATE attempts SET pid=?,worktree=? WHERE launch_id=?")
      .run(pid ?? null, worktree, launchId);
  }
  enqueue(job: Launch, state: string, extra: Record<string, unknown> = {}) {
    const payload = {
      host_id: job.host_id,
      launch_id: job.launch_id,
      lease_id: job.lease_id,
      state,
      ...extra,
      idempotency_key: `host:${job.launch_id}:${state}`,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO outbox(launch_id,state,payload) VALUES (?,?,?)",
        )
        .run(job.launch_id, state, JSON.stringify(payload));
      if (["completed", "failed", "waiting", "uncertain"].includes(state)) {
        const notice = {
          to: job.parent_session_id,
          thread_id: `launch:${job.launch_id}`,
          kind: state === "completed" ? "result" : "blocker",
          body: `Host ${job.host_id}; assignment ${job.assignment_id}; launch ${job.launch_id}: native run ${state}. ${state === "completed" ? "Coordinator must verify the assignment criteria." : ""}\nNative identity: ${extra.native_session_id ?? "unconfirmed"}.\n${extra.detail ?? ""}\n${extra.result ?? ""}`.slice(
            0,
            6000,
          ),
          idempotency_key: `host-notice:${job.launch_id}:${state}`,
        };
        this.db
          .prepare(
            "INSERT OR IGNORE INTO notices(launch_id,state,payload) VALUES (?,?,?)",
          )
          .run(job.launch_id, state, JSON.stringify(notice));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async flush(client: Client): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      return this.flush(client);
    }
    this.flushing = this.flushReports(client);
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }
  private async flushReports(client: Client) {
    for (const row of this.db
      .prepare("SELECT seq,payload FROM outbox WHERE sent=0 ORDER BY seq")
      .all() as { seq: number; payload: string }[]) {
      try {
        await client.call("report_launch", JSON.parse(row.payload));
      } catch (error) {
        // An explicit rejection proves this operation was not accepted. Preserve
        // it, then let the caller report a pre-spawn failure; never retry a bad fence.
        if (
          error instanceof BoardError &&
          [400, 403, 409].includes(error.status)
        ) {
          this.db.exec("BEGIN IMMEDIATE");
          try {
            this.db
              .prepare("UPDATE outbox SET sent=2 WHERE seq=?")
              .run(row.seq);
            const payload = JSON.parse(row.payload) as {
              launch_id: string;
              state: string;
            };
            const attempt = this.db
              .prepare("SELECT job FROM attempts WHERE launch_id=?")
              .get(payload.launch_id);
            if (attempt) {
              const job = JSON.parse(attempt.job as string) as Launch;
              const notice = {
                to: job.parent_session_id,
                thread_id: `launch:${job.launch_id}`,
                kind: "blocker",
                body: `Host report for launch ${job.launch_id} was rejected at ${payload.state} (HTTP ${error.status}). Native evidence and work are preserved. Run completion is unconfirmed; reconcile the host journal before any replacement.`,
                idempotency_key: `host-notice:${job.launch_id}:report_rejected`,
              };
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO notices(launch_id,state,payload) VALUES (?,'report_rejected',?)",
                )
                .run(job.launch_id, JSON.stringify(notice));
            }
            this.db.exec("COMMIT");
          } catch (cause) {
            this.db.exec("ROLLBACK");
            throw cause;
          }
        }
        throw error;
      }
      this.db.prepare("UPDATE outbox SET sent=1 WHERE seq=?").run(row.seq);
    }
  }
  async notify(agent: Client) {
    for (const row of this.db
      .prepare(
        "SELECT n.launch_id,n.state,n.payload FROM notices n WHERE sent=0 AND ((n.state='report_rejected' AND EXISTS (SELECT 1 FROM outbox o WHERE o.launch_id=n.launch_id AND o.sent=2)) OR (EXISTS (SELECT 1 FROM outbox o WHERE o.launch_id=n.launch_id AND o.state=n.state AND o.sent=1) AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.launch_id=n.launch_id AND o.sent=0)))",
      )
      .all() as { launch_id: string; state: string; payload: string }[]) {
      await agent.call("send", JSON.parse(row.payload));
      this.db
        .prepare("UPDATE notices SET sent=1 WHERE launch_id=? AND state=?")
        .run(row.launch_id, row.state);
    }
  }
  recover() {
    for (const row of this.db
      .prepare(
        "SELECT a.job,o.state,o.payload FROM outbox o JOIN attempts a ON a.launch_id=o.launch_id WHERE o.state IN ('completed','failed','waiting','uncertain')",
      )
      .all() as { job: string; state: string; payload: string }[]) {
      this.enqueue(
        JSON.parse(row.job) as Launch,
        row.state,
        JSON.parse(row.payload),
      );
    }
    // A terminal event already persisted before the crash is sufficient to
    // finish its outbox; do not append an incompatible uncertainty report.
    this.db.exec(
      "UPDATE attempts SET phase='terminal' WHERE EXISTS (SELECT 1 FROM outbox WHERE outbox.launch_id=attempts.launch_id AND state IN ('completed','failed'))",
    );
    for (const row of this.db
      .prepare("SELECT launch_id,job FROM attempts WHERE phase='prepared'")
      .all() as { launch_id: string; job: string }[]) {
      // No spawn marker exists. A persisted launch fence may have reached the
      // hub, but this process never attempted its external effect.
      this.db
        .prepare("UPDATE outbox SET sent=2 WHERE launch_id=? AND sent=0")
        .run(row.launch_id);
      this.enqueue(JSON.parse(row.job) as Launch, "failed", {
        detail:
          "Host restarted before the native spawn marker. No native launch was attempted; preparation and rejected reports preserved.",
      });
      this.phase(row.launch_id, "terminal");
    }
    for (const row of this.db
      .prepare(
        "SELECT * FROM attempts WHERE phase NOT IN ('prepared','terminal','uncertain')",
      )
      .all() as {
      launch_id: string;
      job: string;
      native_id: string | null;
    }[]) {
      const job = JSON.parse(row.job) as Launch;
      this.enqueue(job, "uncertain", {
        ...(row.native_id ? { native_session_id: row.native_id } : {}),
        detail:
          "Host restarted after a native launch attempt. Preserved for supported reconciliation; no automatic respawn.",
      });
      this.phase(row.launch_id, "uncertain");
    }
  }
  close() {
    this.db.close();
    this.lock.close();
  }
}

const execute = promisify(execFile);
export async function prepareWorktree(repository: string, job: Launch) {
  if (!isAbsolute(repository))
    throw new Error("Approved repository must have an absolute path");
  const root = realpathSync(repository);
  const bare =
    (
      await execute("git", ["-C", root, "rev-parse", "--is-bare-repository"])
    ).stdout.trim() === "true";
  const top = realpathSync(
    (
      await execute("git", [
        "-C",
        root,
        "rev-parse",
        bare ? "--absolute-git-dir" : "--show-toplevel",
      ])
    ).stdout.trim(),
  );
  if (relative(root, top) !== "")
    throw new Error(
      "Approved repository must be its exact Git worktree or bare repository root",
    );
  const actual = (
    await execute("git", ["-C", root, "rev-parse", `${job.base_sha}^{commit}`])
  ).stdout.trim();
  if (actual.toLowerCase() !== job.base_sha.toLowerCase())
    throw new Error("Base must be an exact available immutable commit");
  const directory = join(root, ".worktrees", "chatterbox-host");
  mkdirSync(directory, { recursive: true });
  if (!inside(root, realpathSync(directory)))
    throw new Error("Host worktree directory escapes approved repository");
  if (!/^launch_[a-f0-9-]{36}$/i.test(job.launch_id))
    throw new Error("Invalid launch ID");
  const target = join(realpathSync(directory), job.launch_id);
  await execute(
    "git",
    [
      "-C",
      root,
      "worktree",
      "add",
      "-b",
      `cb/${job.launch_id}`,
      target,
      actual,
    ],
    { timeout: 30000 },
  );
  if (!inside(directory, realpathSync(target)))
    throw new Error("Created worktree escapes its owned directory");
  return target;
}

function checkNativeExecutable(path: string) {
  if (!isAbsolute(path) || !statSync(path).isFile())
    throw new Error(
      "Provider executable must be an existing absolute native binary",
    );
  const bytes = Buffer.alloc(4),
    fd = openSync(path, "r");
  try {
    readSync(fd, bytes, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  const magic = bytes.toString("hex");
  if (!(
    magic.startsWith("4d5a") ||
    [
      "7f454c46",
      "cffaedfe",
      "feedfacf",
      "cafebabe",
      "bebafeca",
      "cffaedfe",
      "cefaedfe",
    ].includes(magic)
  ))
    throw new Error(
      "Shell scripts and command wrappers cannot be host provider executables",
    );
}
function assignment(job: Launch, worktree: string) {
  return `You are a newly created headless worker, delegated by coordinator ${job.parent_session_id}.\nBegin your first assistant output with this readiness nonce on its own line: ${job.nonce}\nThe nonce is only the first line, not the whole response. Continue and complete this bounded assignment in this same turn, including a final result. Do not stop after the nonce. Do not create or delegate to other sessions.\nAssignment ID: ${job.assignment_id}\nOwned worktree: ${worktree}\nBase revision: ${job.base_sha}\nObjective:\n${job.objective}\nAcceptance criteria:\n${job.criteria}\nAll writes stay in the owned worktree. Follow its agent instructions. Native authentication and approval policy remain in force.\nChatterBox MCP is disabled during bootstrap to prevent inherited identity. Your exact native identity and assistant acknowledgement are reported by the host, with native_assistant_output provenance. Your final assistant result is forwarded to ${job.parent_session_id}. Report blockers and do not claim unperformed work.\n`;
}

export async function launchWorker(
  config: HostConfig,
  job: Launch,
  journal: HostJournal,
  client: Client,
  agent?: Client,
) {
  journal.attempt(job);
  if (
    !config.coordinators.includes(job.parent_session_id) ||
    config.authorization_expires_at <= Date.now()
  )
    throw new Error(
      "Local coordinator authorization expired or does not match",
    );
  const provider = config.providers.find((p) => p.provider === job.provider);
  const repository = config.repositories[job.repository];
  if (!provider || !repository)
    throw new Error("Local provider or repository alias is not approved");
  checkNativeExecutable(provider.executable);
  const worktree = await prepareWorktree(repository, job);
  journal.enqueue(job, "launching");
  await journal.flush(client); // Final Board authorization is confirmed before any native spawn.
  if (config.authorization_expires_at <= Date.now())
    throw new Error(
      "Local launch authorization expired while preparing worktree",
    );
  journal.phase(job.launch_id, "spawn_attempted"); // Persist before spawn; a crash is uncertain, never a retry.
  const expected = randomUUID();
  const child = spawn(
    provider.executable,
    providerArguments(job.provider, worktree, expected),
    {
      cwd: worktree,
      env: workerEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  journal.process(job.launch_id, child.pid, worktree);
  let nativeId: string | undefined,
    ready = false,
    done = false,
    failed = false,
    malformed = false,
    result = "",
    buffer = "";
  const accept = (line: string) => {
    let event: NativeEvent;
    try {
      event = nativeEvent(job.provider, JSON.parse(line));
    } catch {
      malformed = true;
      return;
    }
    if (event.nativeId) {
      if (
        !z.uuid().safeParse(event.nativeId).success ||
        (nativeId && nativeId !== event.nativeId) ||
        (job.provider === "claude-code" && event.nativeId !== expected)
      ) {
        malformed = true;
        return;
      }
      if (!nativeId) {
        nativeId = event.nativeId;
        journal.phase(job.launch_id, "native_created", nativeId);
        journal.enqueue(job, "native_created", { native_session_id: nativeId });
      }
    }
    if (event.assistant) {
      result = event.assistant.slice(-4000);
      if (
        !ready &&
        nativeId &&
        event.assistant.split(/\r?\n/).some((v) => v.trim() === job.nonce)
      ) {
        ready = true;
        journal.phase(job.launch_id, "ready", nativeId);
        journal.enqueue(job, "ready", {
          native_session_id: nativeId,
          acknowledgement_nonce: job.nonce,
          ack_source: "native_assistant_output",
        });
      }
    }
    done ||= !!event.done;
    failed ||= !!event.failed;
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) {
      malformed = true;
      buffer = "";
      return;
    }
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) accept(line);
    }
  });
  let diagnostic =
    "Native initialization or assignment acknowledgement is still pending";
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (
      /not logged in|authentication required|please (?:run|use).*login/i.test(
        text,
      )
    )
      diagnostic = "Local provider authentication is required";
    else if (/permission|approval required|not allowed/i.test(text))
      diagnostic = "Native permission or approval requires attention";
  }); // Classify only; never retain/publish raw stderr or credentials.
  child.stdin.on("error", () => {
    failed = true;
  });
  child.stdin.end(assignment(job, worktree));
  const flushTimer = setInterval(() => {
    void journal
      .flush(client)
      .catch(() => {})
      .then(() => (agent ? journal.notify(agent) : undefined))
      .catch(() => {});
  }, 3000);
  const readinessTimer = setTimeout(() => {
    if (ready) return;
    journal.enqueue(job, "waiting", {
      ...(nativeId ? { native_session_id: nativeId } : {}),
      detail: `${diagnostic} after 60 seconds. Native work is preserved and its host slot remains reserved; do not start a replacement.`,
    });
    journal.phase(job.launch_id, "waiting", nativeId);
    void journal
      .flush(client)
      .then(() => (agent ? journal.notify(agent) : undefined))
      .catch(() => {});
  }, 60000);
  // Serialize flushes: an ambiguous HTTP response must retry the same durable key.
  let exit: number | null;
  try {
    exit = await new Promise<number | null>((resolve) => {
      child.once("error", () => {
        failed = true;
        resolve(null);
      });
      child.once("close", resolve);
    });
    if (buffer.trim()) accept(buffer.trim());
  } finally {
    clearInterval(flushTimer);
    clearTimeout(readinessTimer);
  }
  const completed =
    exit === 0 &&
    done &&
    ready &&
    !!nativeId &&
    !failed &&
    !malformed &&
    result
      .split(/\r?\n/)
      .some((line) => line.trim() !== "" && line.trim() !== job.nonce);
  journal.enqueue(job, completed ? "completed" : "failed", {
    ...(nativeId ? { native_session_id: nativeId } : {}),
    result: completed ? result : "",
    detail: completed
      ? `Native headless worker completed in ${worktree}`
      : "Native worker exited without verified identity, readiness and successful outcome. Inspect its native transcript; owned worktree preserved.",
  });
  journal.phase(job.launch_id, "terminal", nativeId);
  await journal.flush(client);
}

export async function runHost(
  path: string,
  signal = new AbortController().signal,
) {
  const config = hostConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (!isAbsolute(config.state_directory) || !isAbsolute(config.connection))
    throw new Error("Host state and connection paths must be absolute");
  if (
    !Object.keys(config.repositories).length ||
    new Set(config.providers.map((v) => v.provider)).size !==
      config.providers.length
  )
    throw new Error("Host needs approved repositories and unique providers");
  const connection = readConfig(config.connection),
    client = new Client(connection.board_url, connection.token);
  const journal = new HostJournal(config.state_directory);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const providers = [];
    for (const p of config.providers) {
      checkNativeExecutable(p.executable);
      const version = (
        await execute(p.executable, ["--version"], {
          timeout: 5000,
          env: workerEnvironment(process.env),
        })
      ).stdout
        .trim()
        .replace(/ \(Claude Code\)$/, "");
      providers.push({
        provider: p.provider,
        version,
        mode: "headless",
        proof: p.proof,
      });
    }
    const service = await client.call<{ session_id: string; token: string }>(
      "register",
      {
        native_session_id: `host:${config.host_id}`,
        provider: "other",
        provider_version: "chatterbox-host 0.1.0",
        runtime_id: "host-service",
        alias: `host-${config.name}`,
        os: process.platform,
        role: "host-service",
        transport: "mailbox",
      },
    );
    const agent = new Client(connection.board_url, service.token);
    await client.call("host_register", {
      host_id: config.host_id,
      name: config.name,
      os: process.platform,
      providers,
      repositories: Object.keys(config.repositories),
      coordinators: config.coordinators,
      authorization_expires_at: config.authorization_expires_at,
      idempotency_key: randomUUID(),
    });
    heartbeat = setInterval(() => {
      void client
        .call("host_heartbeat", { host_id: config.host_id })
        .catch(() => {});
      void client
        .call("heartbeat", { session_id: service.session_id })
        .catch(() => {});
    }, 10000);
    journal.recover();
    while (!signal.aborted) {
      try {
        await journal.flush(client);
        await journal.notify(agent);
        await client.call("host_heartbeat", { host_id: config.host_id });
        await client.call("heartbeat", { session_id: service.session_id });
        const result = await client.call<{ launches: Launch[] }>(
          "claim_launch",
          { host_id: config.host_id },
        );
        for (const job of result.launches) {
          try {
            await launchWorker(config, job, journal, client, agent);
          } catch {
            const row = journal.db
              .prepare("SELECT phase FROM attempts WHERE launch_id=?")
              .get(job.launch_id);
            if (row?.phase === "terminal") {
              await journal.flush(client);
              continue;
            }
            const uncertain =
              row && !["prepared", "terminal"].includes(row.phase as string);
            journal.enqueue(job, uncertain ? "uncertain" : "failed", {
              detail: uncertain
                ? "Native launch or report outcome is uncertain. No automatic respawn; reconcile preserved native evidence."
                : "Host could not prepare this authorized assignment. Native launch was not attempted; inspect private host setup and owned worktree.",
            });
            journal.phase(job.launch_id, uncertain ? "uncertain" : "terminal");
            await journal.flush(client);
          }
          await journal.notify(agent);
        }
      } catch {
        console.error(
          "Host connection/report unavailable; preserving durable launch state and retrying.",
        );
      }
      await delay(10000, undefined, { signal }).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
    journal.close();
  }
}
