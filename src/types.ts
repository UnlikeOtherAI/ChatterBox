import { z } from "zod";

export const name = z.string().trim().min(1).max(160);
export const id = z.string().min(1).max(200);
export const state = z.enum([
  "online",
  "working",
  "idle",
  "blocked",
  "waiting",
  "offline",
  "unknown",
]);
export const capability = z.enum(["MAILBOX", "QUEUED", "LIVE", "CHECKPOINT"]);
export const kind = z.enum([
  "message",
  "request",
  "reply",
  "status",
  "handoff",
  "blocker",
  "decision",
  "result",
]);
export const vector = z
  .array(z.number().finite())
  .min(1)
  .max(4096)
  .refine(
    (v) => v.some((n) => n !== 0),
    "A vector must have nonzero magnitude",
  );
const page = {
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).default(50),
};
const key = { idempotency_key: id };
const send = {
  ...key,
  body: z.string().trim().min(1).max(16000),
  kind: kind.default("message"),
  thread_id: name,
  reply_to: id.optional(),
  repo_id: name.optional(),
  commit_sha: z
    .string()
    .regex(/^[a-f0-9]{7,64}$/i)
    .optional(),
};
export const schemas = {
  register: z
    .object({
      native_session_id: id,
      provider: z.enum(["codex", "claude-code", "other"]),
      provider_version: name,
      runtime_id: name,
      alias: name,
      os: z.enum(["darwin", "win32", "linux"]),
      repository: z.string().max(1024).default(""),
      role: name.default("developer"),
      transport: z
        .enum(["mailbox", "codex-queue", "claude-channel"])
        .default("mailbox"),
    })
    .strict(),
  sessions: z
    .object({
      provider: name.optional(),
      os: name.optional(),
      role: name.optional(),
      state: state.optional(),
      capability: capability.optional(),
      machine_id: id.optional(),
      ...page,
    })
    .strict(),
  send: z.object({ ...send, to: id }).strict(),
  broadcast: z
    .object({
      ...send,
      provider: name.optional(),
      os: name.optional(),
      role: name.optional(),
    })
    .strict(),
  messages: z
    .object({
      ...page,
      thread_id: name.optional(),
      pending: z.boolean().default(false),
      kind: kind.optional(),
      session_id: id.optional(),
    })
    .strict(),
  thread: z.object({ ...page, thread_id: name }).strict(),
  ack: z
    .object({
      ...key,
      message_id: id,
      acknowledgement: z.enum([
        "received",
        "accepted",
        "declined",
        "completed",
        "failed",
      ]),
      note: z.string().max(2000).default(""),
    })
    .strict(),
  status: z
    .object({
      ...key,
      state,
      task: z.string().max(500).default(""),
      revision: z.string().max(64).default(""),
    })
    .strict(),
  search: z
    .object({
      ...page,
      query: z.string().trim().max(512).default(""),
      thread_id: name.optional(),
      kind: kind.optional(),
      model: name.optional(),
      vector: vector.optional(),
    })
    .strict()
    .refine((v) => !!v.query || !!v.vector, "Provide search text or a vector")
    .refine(
      (v) => Boolean(v.model) === Boolean(v.vector),
      "A vector requires its exact model identifier",
    ),
  embed: z.object({ ...key, message_id: id, model: name, vector }).strict(),
  audit: z.object({ ...page, message_id: id.optional() }).strict(),
  claim: z.object({ session_id: id }).strict(),
  report: z
    .object({
      message_id: id,
      session_id: id,
      lease_id: id,
      state: z.enum([
        "stored_on_recipient",
        "delivery_attempted",
        "queued_with_provider",
        "notification_sent",
        "retry_wait",
      ]),
      detail: z.string().max(1000).default(""),
    })
    .strict(),
  heartbeat: z.object({ session_id: id }).strict(),
};
export type Method = keyof typeof schemas;
export type Principal = {
  id: string;
  workspace_id: string;
  project_id: string;
  machine_id: string;
  role: "machine" | "session" | "viewer";
  session_id: string | null;
};
export type Session = {
  agent_session_id: string;
  workspace_id: string;
  project_id: string;
  machine_id: string;
  runtime_id: string;
  native_session_id: string;
  provider: string;
  provider_version: string;
  alias: string;
  os: string;
  role: string;
  repository: string;
  capability: string;
  transport: string;
  state: string;
  task: string;
  revision: string;
  last_seen: number;
  state_at: number;
  owner_id: string;
  connection?: string;
};
export type Message = {
  seq: number;
  message_id: string;
  workspace_id: string;
  project_id: string;
  thread_id: string;
  from_session_id: string;
  kind: string;
  body: string;
  reply_to: string | null;
  repo_id: string | null;
  commit_sha: string | null;
  created_at: number;
  body_hash: string;
  from_alias?: string;
  deliveries?: Delivery[];
  embedding_count?: number;
  score?: number;
};
export type Delivery = {
  message_id: string;
  to_session_id: string;
  state: string;
  attempts: number;
  lease_id: string | null;
  lease_until: number;
  next_attempt: number;
  detail: string;
  updated_at: number;
  acknowledgement: string | null;
  to_alias?: string;
};
export class BoardError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new BoardError(status, message);
}
