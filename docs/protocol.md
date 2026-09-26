# Protocol

This is the initial contract to implement and test. Provider adapters may expose less than the full surface; capability fields state what they can actually deliver.

## MCP methods

| Method            | Purpose                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `board_register`  | Register or resume this native session and return canonical identity, peers, capability, and pending count. |
| `board_sessions`  | List visible sessions with project, machine, provider, OS, role, status, and capability filters.            |
| `board_send`      | Persist one message for one unambiguous alias or session ID.                                                |
| `board_broadcast` | Persist one message for each matching participant in the caller's project.                                  |
| `board_messages`  | Page pending or historical messages with an opaque cursor.                                                  |
| `board_ack`       | Record a transport or work acknowledgement for a message.                                                   |
| `board_status`    | Publish bounded task, state, and revision metadata.                                                         |
| `board_thread`    | Read a bounded, project-scoped conversation.                                                                |

All mutating methods require an idempotency key or equivalent replay protection. `board_send` and `board_broadcast` return accepted message IDs and initial delivery states. They do not return a false success for native injection. Inputs have strict size limits; cursors are opaque and scoped.

## Message envelope

```json
{
  "protocol_version": 1,
  "message_id": "msg_random",
  "workspace_id": "ws_random",
  "project_id": "desktop-app",
  "thread_id": "windows-build",
  "from_session_id": "ses_mac",
  "to_session_id": "ses_windows",
  "kind": "request",
  "reply_to": null,
  "repo_id": "desktop-client",
  "commit_sha": "abc123",
  "body": "Please test this revision on native Windows.",
  "created_at": "2026-09-26T12:00:00Z",
  "idempotency_key": "sender-generated-key"
}
```

The server owns `message_id`, canonical sender/recipient IDs, and `created_at`. `kind` begins with `message`, `request`, `reply`, `status`, `handoff`, `blocker`, `decision`, and `result`; avoid a large taxonomy. A thread survives replacement of an agent session.

## Delivery and acknowledgement

Delivery records advance through `accepted_by_board`, `routed`, `stored_on_recipient`, `delivery_attempted`, and `acknowledged`, with failure and retry metadata. A board acceptance is durable storage only. A native adapter must report the observed boundary it crossed; it cannot infer that an agent processed a message from a successful write to a socket.

Work acknowledgements are independent: `received`, `accepted`, `declined`, `completed`, and `failed`. They identify the acknowledging session and time. A recipient may decline a request even after transport delivery succeeds.

## Capabilities

- `LIVE`: tested delivery into the current native session during active work.
- `QUEUED`: tested automatic delivery after the current turn.
- `CHECKPOINT`: tested delivery at a provider lifecycle boundary.
- `MAILBOX`: explicit MCP retrieval is required.

Report capability per native session and provider version, with evidence. An unknown capability defaults to `MAILBOX`. A read-only dashboard must expose the board state and capability without collapsing them into a single online badge.
