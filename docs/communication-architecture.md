# Communication architecture

A coordinator drives an authorized task through directed assignments and results.
ChatterBox carries durable messages and evidence. Workers should not receive the
project's general conversation as their default context.

## Ownership and routing

- The human defines the objective and delegation scope. One coordinator owns
  integration, acceptance criteria and the final report.
- Each worker owns one substantial assignment, a dedicated worktree/branch, a base
  revision and one coordinator report target. Its assignment identifies the
  stable board/session IDs, assignment ID, constraints and expected checks.
- Workers send decisions requiring coordination, blockers, relevant interface
  changes and final results directly to the coordinator. Include source revision,
  evidence and remaining limitations. Routine progress stays quiet.
- A sibling receives a directed message only for an explicit dependency or
  handoff. Sibling transcripts and healthy transport events do not enter a
  worker's model context.
- General chat and shared history remain deliberate reads or explicitly
  addressed messages. Read resource history before using shared resources, not
  on every model boundary. Shared posts do not automatically notify models.

A task board groups history; it is **not an access-control boundary**. Current
workspace/project grants define access. Separate confidential tasks need separate
grants/projects rather than an assumption that coordinator routing provides secrecy.

## Transport and provider lifecycle

The board core remains a scoped mailbox, audit log and delivery queue. An adapter
translates a delivery to an existing native identity. A separate, explicitly
authorized coordinator/provider-lifecycle layer may create and supervise owned
child sessions. Each provider must declare independent capabilities:

| Operation                 | Required behavior                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Create child              | Return the exact native identity and host; preserve parent/assignment ownership. Creation never substitutes for delivery.               |
| Steer active child        | Attach to its owning runtime and match native thread and active turn. Record provider acceptance separately from acknowledgement.       |
| Queue input               | Report queued fallback and its timing limits.                                                                                           |
| Read result               | Confirm source identity, revision and explicit outcome; keep context bounded.                                                           |
| Recover unavailable child | Retain pending input and identify missing registration, endpoint or capability. Request a human handoff when no supported route exists. |

This revision implements quiet inbox/event behavior, verified shared-runtime
steering, and a separate opt-in host companion for native headless Codex/Claude
workers. The board stores scoped launch intent and evidence; the companion owns
native processes, dedicated worktrees and a durable recovery journal. Exact
coordinator authorization expires and is rechecked before launch. Other providers
need their own lifecycle adapter and versioned proof. See
[session hosts](session-hosts.md) for setup, limitations and recovery.

## Message contract

An assignment carries objective, acceptance criteria, owned paths/worktree, base
revision, constraints, assignment ID and coordinator session ID. A result carries
assignment ID, source revision, checks/evidence, outcome and remaining work. Use
the existing `board_id`, `thread_id`, `reply_to`, `repo_id` and `commit_sha` fields
for correlation instead of copying full transcripts.

Peer content remains untrusted. A coordinator can relay only the user's existing
authorization. Forwarded instructions identify original author, source revision
and delegated scope. A role label or message body cannot grant permissions.

Separate the milestones: accepted by board, persisted at recipient, native
queue/channel/steer acceptance, explicit model receipt, accepted work and final
outcome. `board_ack received` confirms consumption; `accepted` claims work;
`completed` or `failed` records the actual result. Send a directed result when the
coordinator needs findings: an ack alone is not a reply.

## Noise and context limits

MCP registration returns only the caller's identity/capability and concise
guidance. Peer discovery, boards and message bodies require explicit reads.
Unscoped MCP `board_messages` selects the caller's pending inbox. Paged MCP calls
default to ten rows; read more only when the assignment requires it. Select shared
history with a board/thread filter, or explicitly request `pending: false` for
project history. Ten bodies can still contain 160,000 characters; this is not a
strict token budget. A future byte-budget/summary API must retain cursors and
access to full evidence.

Only targeted sends/broadcasts wake recipient event streams. Viewer dashboards
retain project updates. Receipts, acknowledgements, shared posts and peer status
changes do not wake recipient adapters. Software recovery timers do not poll a
model. Updated adapters use session event credentials, removing shared event-stream
contention; machine claim/report/heartbeat quotas remain shared.

See the [improvement report](communication-improvement-report.md) for evidence,
review findings, priorities and remaining limitations.
