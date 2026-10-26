import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Principal } from "./types.js";
import { fail } from "./errors.js";
import type { Board } from "./store.js";
import {
  coordinatorPolicy,
  permitsLaunch,
  hostModel,
  reasoningEffort,
  validGrantReferences,
  coordinatorGrant,
} from "./host-policy.js";

const id = z.string().min(1).max(200);
const label = z.string().trim().min(1).max(120);
const provider = z.enum(["codex", "claude-code"]);
const page = {
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).default(10),
};
export const lifecycleSchemas = {
  hosts: z.object({ ...page, provider: provider.optional() }).strict(),
  host_register: z
    .object({
      host_id: id,
      name: label,
      os: z.enum(["win32", "darwin", "linux"]),
      providers: z
        .array(
          z
            .object({
              provider,
              version: label,
              mode: z.literal("headless"),
              proof: z.string().max(200).default("unverified"),
            })
            .strict(),
        )
        .min(1)
        .max(8),
      repositories: z.array(label).min(1).max(20),
      ...coordinatorPolicy,
      coordinators: z.array(id).max(16).optional(),
      coordinator_grants: z.array(coordinatorGrant).max(16).optional(),
      policy_version: z.number().int().min(0).max(1).optional(),
      authorization_expires_at: z.number().int().positive(),
      idempotency_key: id,
    })
    .strict()
    .refine(
      (v) =>
        (v.coordinators?.length ?? 0) + (v.coordinator_grants?.length ?? 0) > 0,
      "At least one coordinator grant is required",
    ),
  host_heartbeat: z.object({ host_id: id }).strict(),
  start_session: z
    .object({
      host_id: id,
      provider,
      mode: z.literal("headless"),
      repository: label,
      model: hostModel.optional(),
      reasoning_effort: reasoningEffort.optional(),
      base_sha: z.string().regex(/^[a-f0-9]{40,64}$/i),
      assignment_id: label,
      objective: z.string().trim().min(1).max(8000),
      criteria: z.string().trim().min(1).max(2000),
      idempotency_key: id,
    })
    .strict()
    .refine(
      (v) => !v.reasoning_effort || (v.provider === "codex" && !!v.model),
      "Reasoning effort requires an explicit Codex model",
    ),
  launches: z
    .object({
      ...page,
      scope: z.enum(["self", "project"]).default("self"),
      host_id: id.optional(),
      launch_id: id.optional(),
    })
    .strict(),
  claim_launch: z
    .object({
      host_id: id,
      policy_version: z.number().int().min(0).max(1).optional(),
    })
    .strict(),
  report_launch: z
    .object({
      host_id: id,
      launch_id: id,
      lease_id: id,
      policy_version: z.number().int().min(0).max(1).optional(),
      state: z.enum([
        "launching",
        "native_created",
        "ready",
        "waiting",
        "completed",
        "failed",
        "uncertain",
      ]),
      native_session_id: z.uuid().optional(),
      acknowledgement_nonce: id.optional(),
      ack_source: z.literal("native_assistant_output").optional(),
      result: z.string().max(4000).default(""),
      detail: z.string().max(1000).default(""),
      idempotency_key: id,
    })
    .strict(),
};
export const lifecycleMethods = new Set(Object.keys(lifecycleSchemas));
type Host = {
  seq: number;
  host_id: string;
  workspace_id: string;
  project_id: string;
  owner_id: string;
  name: string;
  os: string;
  providers: string;
  repositories: string;
  coordinators: string;
  coordinator_grants: string;
  policy_version: number;
  authorization_expires_at: number;
  last_seen: number;
};
export type Launch = {
  seq: number;
  launch_id: string;
  host_id: string;
  workspace_id: string;
  project_id: string;
  requester_id: string;
  parent_session_id: string;
  provider: "codex" | "claude-code";
  repository: string;
  model: string | null;
  reasoning_effort: string | null;
  base_sha: string;
  assignment_id: string;
  objective: string;
  criteria: string;
  nonce: string;
  state: string;
  native_session_id: string | null;
  ack_source: string | null;
  lease_id: string | null;
  lease_until: number;
  attempts: number;
  result: string;
  detail: string;
  created_at: number;
  updated_at: number;
};

export function initializeLifecycle(board: Board) {
  board.db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_hosts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,host_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES credentials(id),
      name TEXT NOT NULL,os TEXT NOT NULL,providers TEXT NOT NULL,repositories TEXT NOT NULL,coordinators TEXT NOT NULL,
      authorization_expires_at INTEGER NOT NULL,last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lifecycle_launches (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,launch_id TEXT NOT NULL UNIQUE,host_id TEXT NOT NULL REFERENCES lifecycle_hosts(host_id),
      workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,requester_id TEXT NOT NULL REFERENCES credentials(id),
      parent_session_id TEXT NOT NULL REFERENCES sessions(agent_session_id),provider TEXT NOT NULL,repository TEXT NOT NULL,
      base_sha TEXT NOT NULL,assignment_id TEXT NOT NULL,objective TEXT NOT NULL,criteria TEXT NOT NULL,nonce TEXT NOT NULL,
      state TEXT NOT NULL,native_session_id TEXT,ack_source TEXT,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,result TEXT NOT NULL DEFAULT '',detail TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_native_identity ON lifecycle_launches(host_id,provider,native_session_id) WHERE native_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS lifecycle_pending ON lifecycle_launches(host_id,state,seq);
  `);
  board.db.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, columns] of [
      [
        "lifecycle_hosts",
        [
          ["coordinator_grants", "TEXT NOT NULL DEFAULT '[]'"],
          ["policy_version", "INTEGER NOT NULL DEFAULT 0"],
        ],
      ],
      [
        "lifecycle_launches",
        [
          ["model", "TEXT"],
          ["reasoning_effort", "TEXT"],
        ],
      ],
    ] as const) {
      const existing = new Set(
        (
          board.db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
          }[]
        ).map((v) => v.name),
      );
      for (const [column, definition] of columns)
        if (!existing.has(column))
          board.db.exec(
            `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
          );
    }
    board.db.exec("COMMIT");
  } catch (error) {
    board.db.exec("ROLLBACK");
    throw error;
  }
}

export function lifecycleCall(
  board: Board,
  p: Principal,
  method: string,
  input: unknown,
) {
  const scope = [p.workspace_id, p.project_id];
  const host = (hostId: string, owned = false) => {
    const found = board.one<Host>(
      "SELECT * FROM lifecycle_hosts WHERE host_id=? AND workspace_id=? AND project_id=?",
      hostId,
      ...scope,
    );
    if (!found) fail(404, "Host is not enrolled in this project");
    if (owned && found.owner_id !== p.id)
      fail(403, "This credential does not own the host");
    return found;
  };
  const launch = (launchId: string, hostId: string) => {
    const found = board.one<Launch>(
      "SELECT * FROM lifecycle_launches WHERE launch_id=? AND host_id=? AND workspace_id=? AND project_id=?",
      launchId,
      hostId,
      ...scope,
    );
    return found ?? fail(404, "Launch not found in this host/project");
  };
  const policy = (h: Host) => ({
    coordinators: JSON.parse(h.coordinators) as string[],
    coordinator_grants: JSON.parse(h.coordinator_grants) as z.infer<
      typeof coordinatorPolicy.coordinator_grants
    >,
  });
  const authorized = (h: Host, sessionId: string) =>
    h.authorization_expires_at > board.now() &&
    (policy(h).coordinators.includes(sessionId) ||
      (h.policy_version >= 1 &&
        policy(h).coordinator_grants.some((v) => v.coordinator === sessionId)));
  const canLaunch = (h: Host, job: Launch) => {
    const authority = board.one<{ revoked: number; owner_revoked: number }>(
      "SELECT c.revoked,owner.revoked AS owner_revoked FROM credentials c JOIN sessions s ON s.agent_session_id=c.session_id JOIN credentials owner ON owner.id=s.owner_id WHERE c.id=?",
      job.requester_id,
    );
    return (
      authorized(h, job.parent_session_id) &&
      permitsLaunch(policy(h), job.parent_session_id, job) &&
      (!job.model || h.policy_version >= 1) &&
      !!authority &&
      !authority.revoked &&
      !authority.owner_revoked &&
      (JSON.parse(h.repositories) as string[]).includes(job.repository) &&
      (JSON.parse(h.providers) as { provider: string }[]).some(
        (v) => v.provider === job.provider,
      )
    );
  };
  if (method === "host_register") {
    const a = lifecycleSchemas.host_register.parse(input);
    if (
      !validGrantReferences(
        {
          coordinators: a.coordinators ?? [],
          coordinator_grants: a.coordinator_grants ?? [],
        },
        a.repositories,
        a.providers.map((v) => v.provider),
      )
    )
      fail(
        400,
        "Coordinator grants must reference configured repositories and providers",
      );
    if (
      !board.one(
        "SELECT 1 FROM sessions WHERE workspace_id=? AND project_id=? AND owner_id=? AND provider='other' AND runtime_id='host-service' AND native_session_id=?",
        ...scope,
        p.id,
        `host:${a.host_id}`,
      )
    )
      fail(409, "Register this host's own service identity before enrollment");
    const old = board.one<Host>(
      "SELECT * FROM lifecycle_hosts WHERE host_id=?",
      a.host_id,
    );
    if (
      old &&
      (old.owner_id !== p.id ||
        old.project_id !== p.project_id ||
        old.workspace_id !== p.workspace_id)
    )
      fail(409, "Host is enrolled to another credential or project");
    if (
      a.authorization_expires_at <= board.now() ||
      a.authorization_expires_at > board.now() + 7 * 86400000
    )
      fail(400, "Coordinator authorization must expire within seven days");
    for (const coordinator of new Set([
      ...(a.coordinators ?? []),
      ...(a.coordinator_grants ?? []).map((v) => v.coordinator),
    ]))
      if (
        !board.one(
          "SELECT 1 FROM sessions WHERE agent_session_id=? AND workspace_id=? AND project_id=?",
          coordinator,
          ...scope,
        )
      )
        fail(
          400,
          "Coordinator must be an exact registered session in this project",
        );
    board.run(
      "INSERT INTO lifecycle_hosts(host_id,workspace_id,project_id,owner_id,name,os,providers,repositories,coordinators,coordinator_grants,policy_version,authorization_expires_at,last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(host_id) DO UPDATE SET name=excluded.name,os=excluded.os,providers=excluded.providers,repositories=excluded.repositories,coordinators=excluded.coordinators,coordinator_grants=excluded.coordinator_grants,policy_version=excluded.policy_version,authorization_expires_at=excluded.authorization_expires_at,last_seen=excluded.last_seen",
      a.host_id,
      ...scope,
      p.id,
      a.name,
      a.os,
      JSON.stringify(a.providers),
      JSON.stringify(a.repositories),
      JSON.stringify(a.coordinators ?? []),
      JSON.stringify(a.coordinator_grants ?? []),
      a.policy_version ?? 0,
      a.authorization_expires_at,
      board.now(),
    );
    board.event(p, "host_enrolled", { host_id: a.host_id });
    return {
      host_id: a.host_id,
      connection: "online",
      mode: "headless",
      authorization_expires_at: a.authorization_expires_at,
    };
  }
  if (method === "host_heartbeat") {
    const a = lifecycleSchemas.host_heartbeat.parse(input);
    host(a.host_id, true);
    board.run(
      "UPDATE lifecycle_hosts SET last_seen=? WHERE host_id=?",
      board.now(),
      a.host_id,
    );
    return { connection: "online" };
  }
  if (method === "hosts") {
    const { cursor, limit, ...a } = lifecycleSchemas.hosts.parse(input);
    const result = board.sequencePage<Host>(
      p,
      ["hosts", a],
      "lifecycle_hosts WHERE workspace_id=? AND project_id=?" +
        (a.provider
          ? " AND EXISTS (SELECT 1 FROM json_each(providers) WHERE json_extract(value,'$.provider')=?)"
          : ""),
      a.provider ? [...scope, a.provider] : scope,
      limit,
      cursor,
    );
    return {
      hosts: result.items.map((h) => ({
        host_id: h.host_id,
        name: h.name,
        os: h.os,
        providers: JSON.parse(h.providers) as unknown,
        repositories: JSON.parse(h.repositories) as unknown,
        mode: "headless",
        policy_version: h.policy_version,
        connection: board.now() - h.last_seen < 45000 ? "online" : "offline",
        launch_authorized: !!p.session_id && authorized(h, p.session_id),
        provider_defaults_authorized:
          !!p.session_id &&
          authorized(h, p.session_id) &&
          policy(h).coordinators.includes(p.session_id),
        launch_grants:
          p.session_id && authorized(h, p.session_id)
            ? policy(h)
                .coordinator_grants.filter(
                  (v) => v.coordinator === p.session_id,
                )
                .map(({ repositories, providers }) => ({
                  repositories,
                  providers,
                }))
            : [],
        authorization_expires_at: h.authorization_expires_at,
      })),
      cursor: result.cursor,
      previous_cursor: result.previous_cursor,
    };
  }
  if (method === "start_session") {
    const a = lifecycleSchemas.start_session.parse(input);
    const h = host(a.host_id);
    if (!p.session_id || !authorized(h, p.session_id))
      fail(
        403,
        "This exact coordinator session has no current host launch authorization",
      );
    if (!permitsLaunch(policy(h), p.session_id, a))
      fail(
        403,
        "Repository, provider, model or reasoning selection is outside this coordinator's grant",
      );
    if (a.model && h.policy_version < 1)
      fail(
        409,
        "This host companion must be upgraded before selecting a model",
      );
    if (!(JSON.parse(h.repositories) as string[]).includes(a.repository))
      fail(403, "Repository alias is not approved on this host");
    if (
      !(JSON.parse(h.providers) as { provider: string }[]).some(
        (value) => value.provider === a.provider,
      )
    )
      fail(400, "Provider is not configured on this host");
    const owner = board.one<{ revoked: number }>(
      "SELECT revoked FROM credentials WHERE id=?",
      h.owner_id,
    );
    if (!owner || owner.revoked) fail(403, "Host credential was revoked");
    if (
      board.one<{ n: number }>(
        "SELECT count(*) AS n FROM lifecycle_launches WHERE host_id=? AND state IN ('queued','claimed','launching','native_created','ready','waiting','uncertain')",
        h.host_id,
      )!.n >= 20
    )
      fail(429, "Host launch backlog is full");
    const launchId = `launch_${randomUUID()}`;
    board.run(
      "INSERT INTO lifecycle_launches(launch_id,host_id,workspace_id,project_id,requester_id,parent_session_id,provider,repository,model,reasoning_effort,base_sha,assignment_id,objective,criteria,nonce,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)",
      launchId,
      h.host_id,
      ...scope,
      p.id,
      p.session_id,
      a.provider,
      a.repository,
      a.model ?? null,
      a.reasoning_effort ?? null,
      a.base_sha,
      a.assignment_id,
      a.objective,
      a.criteria,
      `CB_READY_${randomUUID()}`,
      board.now(),
      board.now(),
    );
    board.event(p, "session_launch_queued", {
      launch_id: launchId,
      host_id: h.host_id,
    });
    return {
      launch_id: launchId,
      host_id: h.host_id,
      state: "queued",
      mode: "headless",
      model: a.model ?? null,
      reasoning_effort: a.reasoning_effort ?? null,
      selection_source: a.model
        ? "requested_native_arguments"
        : "provider_default",
      connection: board.now() - h.last_seen < 45000 ? "online" : "offline",
      detail:
        "New native headless worker requested; no process, native identity or assignment acknowledgement is confirmed yet",
    };
  }
  if (method === "launches") {
    const { cursor, limit, ...a } = lifecycleSchemas.launches.parse(input);
    if (a.scope === "self" && !p.session_id)
      fail(400, "Own launches require a session credential");
    let where = "workspace_id=? AND project_id=?";
    const params = [...scope];
    if (a.scope === "self") {
      where += " AND parent_session_id=?";
      params.push(p.session_id!);
    }
    if (a.host_id) {
      where += " AND host_id=?";
      params.push(a.host_id);
    }
    if (a.launch_id) {
      where += " AND launch_id=?";
      params.push(a.launch_id);
    }
    const result = board.sequencePage(
      p,
      ["launches", a],
      `(SELECT seq,launch_id,host_id,parent_session_id,provider,repository,model,reasoning_effort,base_sha,assignment_id,state,native_session_id,ack_source,result,detail,created_at,updated_at FROM lifecycle_launches WHERE ${where}) WHERE 1=1`,
      params,
      limit,
      cursor,
    );
    return {
      launches: result.items,
      cursor: result.cursor,
      previous_cursor: result.previous_cursor,
    };
  }
  if (method === "claim_launch") {
    const a = lifecycleSchemas.claim_launch.parse(input);
    const h = host(a.host_id, true);
    if (
      board.one(
        "SELECT 1 FROM lifecycle_launches WHERE host_id=? AND (state IN ('launching','native_created','ready','waiting','uncertain') OR (state='claimed' AND lease_until>?))",
        h.host_id,
        board.now(),
      )
    )
      return { launches: [] };
    const job = board.one<Launch>(
      "SELECT * FROM lifecycle_launches WHERE host_id=? AND (state='queued' OR (state='claimed' AND lease_until<=?)) ORDER BY seq LIMIT 1",
      h.host_id,
      board.now(),
    );
    if (!job) return { launches: [] };
    if (job.model && (a.policy_version ?? 0) < 1)
      fail(
        409,
        "Explicit model launches require a model-aware companion claim",
      );
    if (!canLaunch(h, job)) {
      board.run(
        "UPDATE lifecycle_launches SET state='failed',detail='Coordinator launch authorization expired or was revoked',updated_at=? WHERE launch_id=?",
        board.now(),
        job.launch_id,
      );
      board.event(p, "session_launch_failed", {
        launch_id: job.launch_id,
        reason: "authorization",
      });
      board.notifyLaunchFailure(
        p,
        h.host_id,
        job.parent_session_id,
        job.launch_id,
      );
      return { launches: [], recipients: [job.parent_session_id] };
    }
    const leaseId = `lease_${randomUUID()}`;
    board.run(
      "UPDATE lifecycle_launches SET state='claimed',lease_id=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE launch_id=?",
      leaseId,
      board.now() + 60000,
      board.now(),
      job.launch_id,
    );
    return {
      launches: [
        {
          ...job,
          state: "claimed",
          lease_id: leaseId,
          lease_until: board.now() + 60000,
          attempts: job.attempts + 1,
        },
      ],
    };
  }
  if (method === "report_launch") {
    const a = lifecycleSchemas.report_launch.parse(input);
    const h = host(a.host_id, true);
    const job = launch(a.launch_id, a.host_id);
    if (job.model && a.state === "launching" && (a.policy_version ?? 0) < 1)
      fail(
        409,
        "Explicit model launches require a model-aware pre-spawn report",
      );
    if (
      !job.lease_id ||
      job.lease_id !== a.lease_id ||
      (job.state === "claimed" &&
        job.lease_until <= board.now() &&
        a.state !== "failed")
    )
      fail(409, "Launch claim expired or is owned by another attempt");
    const transitions: Record<string, string[]> = {
      claimed: ["launching", "failed"],
      launching: ["native_created", "failed", "waiting", "uncertain"],
      native_created: ["ready", "failed", "waiting", "uncertain"],
      waiting: ["native_created", "ready", "failed", "uncertain"],
      ready: ["completed", "failed", "uncertain"],
      uncertain: ["native_created", "ready", "completed", "failed"],
    };
    if (!(transitions[job.state] ?? []).includes(a.state))
      fail(409, "Invalid launch state transition");
    if (a.state === "launching" && !canLaunch(h, job))
      fail(
        403,
        "Coordinator launch authorization expired, changed or was revoked",
      );
    if (
      a.native_session_id &&
      job.native_session_id &&
      a.native_session_id !== job.native_session_id
    )
      fail(409, "Native launch identity cannot change");
    const native = a.native_session_id ?? job.native_session_id;
    if (["native_created", "ready", "completed"].includes(a.state) && !native)
      fail(400, "Native identity evidence is required");
    if (
      a.state === "ready" &&
      (a.acknowledgement_nonce !== job.nonce ||
        a.ack_source !== "native_assistant_output")
    )
      fail(400, "Exact assignment acknowledgement and provenance are required");
    if (a.state === "completed" && !job.ack_source)
      fail(
        409,
        "A process exit cannot substitute for assignment acknowledgement",
      );
    const ack = a.state === "ready" ? a.ack_source! : job.ack_source;
    board.run(
      "UPDATE lifecycle_launches SET state=?,native_session_id=?,ack_source=?,result=?,detail=?,updated_at=? WHERE launch_id=?",
      a.state,
      native,
      ack,
      a.result,
      a.detail,
      board.now(),
      job.launch_id,
    );
    board.event(p, `session_launch_${a.state}`, {
      launch_id: job.launch_id,
      native_session_id: native,
      ack_source: ack,
    });
    return {
      launch_id: job.launch_id,
      state: a.state,
      native_session_id: native,
      ack_source: ack,
    };
  }
  return fail(404, "Unknown lifecycle operation");
}
