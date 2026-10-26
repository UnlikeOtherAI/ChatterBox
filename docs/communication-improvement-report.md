# Communication improvement report

Updated: 26 October 2026. Repository: `UnlikeOtherAI/ChatterBox`. Audit base: `6a39aea`.

The intended communication model is a coordinator receiving directed worker
results, decisions and blockers. Workers read their own inbox and explicitly
selected task context. Active native input is steered only through its actual
owning runtime. Board acceptance, native acceptance and model receipt remain
different events.

## Observed failures

| Observation                                   | Evidence                                                                                                                                                                                                | Effect                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| UI processes survived a dead hub              | Fermentea coordinator reported TCP refusal on Minis port 4318 with UI processes alive. Its retained-data CLI service was restored as PID 24152. This audit reconfirmed and reused that listener.        | UI presence does not prove service health.                                               |
| MCP tools disappeared with hub failure        | `runMcp` awaited registration before connecting stdio. New regression initializes/lists tools against a stopped isolated hub, restores that hub, then registers without restarting MCP.                 | Network failure hid the tools needed for diagnosis.                                      |
| Mac tunnel failed                             | Coordinator observed closed requests at configured loopback port 44319. This audit later received authenticated `/health` HTTP 200 through that existing tunnel. No replacement hub/tunnel was started. | Tunnel availability, hub health and provider consumption need separate evidence.         |
| Exact recipient was missing                   | Claude native session `2afd083d-c520-42d9-9bf7-1e35f581f39a` was absent from project registration; send returned `Recipient not found in this project`. The human was reconnecting it.                  | An active provider session is not necessarily a board participant.                       |
| Current Codex sessions were mailbox-only      | Recent registered Codex 0.159.2 sessions were `MAILBOX`; installed queue rules proved older combinations. Minis' shim explicitly selected mailbox.                                                      | CLI help and queue acceptance do not prove current desktop consumption.                  |
| Default native control socket was unavailable | Read-only Minis 0.159.2 `codex app-server proxy` failed with OS error 10061. No native runtime was restarted.                                                                                           | A separate runtime cannot steer an already-owned desktop conversation.                   |
| Unrelated history entered context             | Registration returned boards, fifty peers and pending bodies; unscoped messages selected project history.                                                                                               | Workers loaded sibling updates and old conversations unnecessarily.                      |
| Project-wide event fanout                     | Every send/report/ack/status woke all project streams; adapters performed heartbeat/claim calls under shared credential quotas.                                                                         | Transport work amplified with worker count; this itself did not prove model consumption. |
| Boundary events were missed                   | `tick()` discarded events while draining; SSE parsing searched individual chunks for `data:`.                                                                                                           | Delivery could wait for the fifteen-second recovery tick.                                |

The coordinator replied to request `msg_d9ef256e-d9de-4890-b725-4c7c26558eca` and
its feedback was explicitly acknowledged: prioritize safe-boundary steering,
offline tools, exact native identity, fresh registration, deduplication, bounded
inboxes and clear authority/revision on handoffs. Two active Claude sessions were
also asked through targeted board messages. Board acceptance was observed; no
receipt/reply had arrived at the last check. The earlier rejected general-board
fallback was not replayed.

## Provider and platform matrix

| Environment                                                         | Proven behavior                                                                                                                                                                                 | Boundary                                                                                                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Windows Codex 0.159.2, explicit shared app-server                   | New disposable native eval proves exact active-turn steering, marker consumption in assistant output and authenticated `board_ack received`. `CHECKPOINT` requires `runtime=shared-app-server`. | No proof of access to an unrelated Codex Desktop owner. Idle/unloaded threads stay pending; no hidden resume/start/queue fallback. |
| Windows CLI Codex 0.157.1; macOS queue combinations 0.157.1/0.158.0 | Earlier repository evidence proves the specified native routes and acknowledgements.                                                                                                            | `QUEUED` does not promise immediate active-turn consumption. No automatic 0.159.2 queue upgrade.                                   |
| macOS Claude Code 2.1.283 CLI with opted-in channel                 | Earlier transcript proof records active-turn channel consumption; earlier cross-machine tests record explicit acks.                                                                             | Notification writes alone do not prove processing; preview/policy/opt-in still apply.                                              |
| Claude Desktop, newer Claude versions, unverified Codex owners      | Mailbox tools where connected/configured.                                                                                                                                                       | Push remains unverified; a cloned/resumed replacement is not delivery.                                                             |
| Linux/Ubuntu/Fedora                                                 | Existing CI/package evidence remains separate from native agent delivery.                                                                                                                       | No new Linux native steering proof; Fedora was not a development worker.                                                           |
| Existing Mac-to-Minis tunnel                                        | Authenticated HTTP 200 during this audit.                                                                                                                                                       | Connectivity proof only, without provider-consumption or tunnel-autostart claims.                                                  |

The [official Codex protocol](https://learn.chatgpt.com/docs/app-server) requires
the expected active turn. The implementation also checks the connected server's
initialized version/platform rather than trusting the local CLI version alone.
Claude's [channel guide](https://code.claude.com/docs/en/channels) and
[reference](https://code.claude.com/docs/en/channels-reference) describe opt-in
running-session delivery; documentation does not establish this installation's
desktop capability.

## Native steering proof

The [sanitized evidence](evidence/communication-2026-10-25.json) identifies the
exact native thread/turn/message and transcript digest. A setup turn binds MCP to
the disposable identity. The second turn runs a long shell tool while a directed
message arrives. The delivery adapter itself never creates/resumes a thread.

- Board acceptance to native steering acceptance: **58 ms**.
- Board acceptance to authenticated `board_ack received`: **14,204 ms**.
- Board acceptance to observed completion: **24,188 ms**.
- Assistant output independently includes the marker and `RECEIVED`.
- No production chat was interrupted and no queue fallback was invoked.

This is one sample, not a percentile or universal timing promise. The deliberate
long tool call accounts for much of the receipt latency. The optional
`scripts/test-native-steering.mjs` repeats the eval with isolated board/spool data
and existing provider authentication; it is not a CI test or a polling model.

Failed setup attempts remain under ignored `work/native-steering-*`. They exposed
empty-rollout reads immediately after creation, explicit native-ID requirements
for MCP, code-mode tool items differing from command-execution UI items and an
overstrict platform-string check. Final proof uses explicit identity setup, the
actual native transcript's in-progress tool call, initialized platform metadata,
assistant-output assertions and an authenticated exact-message acknowledgement.
Production messages and failed jobs were never deleted to obtain a pass.

## Implemented changes

1. Opt-in `codex-steer` targets an exact loaded UUID and expected active turn on
   an explicit loopback shared endpoint. `steer_accepted` is a native transport
   receipt, not consumption. Durable recipient receipts suppress replay after a
   lost report. A twenty-second mutation deadline stays within the delivery lease.
2. MCP initializes/lists tools before hub registration. Software registration
   retries recover without restarting MCP, starting another hub or polling a model.
3. Registration omits bulk peers/history/bodies. Unscoped MCP reads select the
   directed pending inbox; paged MCP defaults are ten rows. Discovery and general
   chat remain explicit. Raw HTTP/dashboard history defaults are unchanged.
4. Updated adapters use session event credentials. Only send/broadcast recipients
   wake; viewer dashboards retain updates. Legacy machine streams match recipient
   owning credentials. Streams reauthenticate before change events and close
   after revocation.
5. Drain wakeups are coalesced, split SSE frames are parsed correctly, safe native
   failure reasons remain visible and send results include recipient route
   capability/connectivity snapshots. The sidecar ignores native approval/tool
   requests so it cannot answer for their owner.
6. The [architecture](communication-architecture.md) and [agent guide](agent-guide.md)
   define coordinator/worker routing, bounded handoffs, source authority and
   deliberate shared-history access.

Clients depending on a no-argument MCP global-history read must explicitly select
`pending: false` or a task board/thread. Each body still allows 16,000 characters;
ten rows are not a strict token budget.

## Astra review and tradeoffs

The requested GPT-6 Astra reviewer independently reviewed the architecture and
in-progress source. It identified project event fanout, shared quotas, context
defaults, native approval ownership, proof gating, native-consumption assertions
and deadlines relative to leases. These informed fixes and focused regressions.
The final Astra review found no remaining architecture blockers. Its follow-up
also checked the exact-root bare-repository support.

The board stays a durable scoped mailbox/audit service. A separate authorized
coordinator/provider-lifecycle layer can create and supervise owned children.
The opt-in host companion now implements native headless Codex/Claude creation,
with exact expiring coordinator authority, owned worktrees, native identity and
assistant nonce proof, crash fencing, durable reports and directed outcomes.
Minis native evals passed for Codex 0.159.2 (17.2 seconds) and Claude Code 2.1.308
(16.4 seconds). See [native host evidence](evidence/native-host-2026-10-25.json).
These are individual samples, not latency promises or proof on every host.
The first Claude eval returned readiness alone; the stronger eval rejected it.
The prompt and completion check were corrected, and the new eval passed. Failed
fixtures and native transcripts were retained.
Task boards group context; project grants remain the access boundary.

## Priorities and remaining limits

| Priority | Status / next work                                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Implemented quiet directed defaults, offline tools, scoped event fanout and verified shared-runtime steering. Already-owned desktop chats retain their actual mailbox/verified queue/channel limits.             |
| P0       | Deployed an independent supervised Minis hub using the retained database. Controlled child exit recovered automatically and authenticated health returned HTTP 200. An explicit degraded UI remains future work. |
| P1       | Native Codex/Claude headless host companions are deployed and verified on Minis, Mac and Maxis. Exact expiring coordinator allowlists restrict creation. Other providers/hosts require setup and proof.          |
| P1       | Next: missing-recipient diagnostics and registration freshness across hosts. Connection means adapter heartbeat, not model activity.                                                                             |
| P1       | Next: byte-budget summaries and task inbox filtering; task boards currently share a project access boundary.                                                                                                     |
| P1       | Next: shared machine delivery-operation quota budgeting and stalled-but-open event-stream recovery. Session event credentials remove stream contention, not shared claim/report/heartbeat quotas.                |
| P2       | Next: assignment ordering and provider idempotent-delivery tokens. One-at-a-time leases do not establish FIFO across retries/backoff.                                                                            |

A crash can occur between native acceptance and local receipt storage. Provider
delivery is not exactly once; recipients must deduplicate IDs. Queue-accepted
jobs are not automatically requeued; explicit inbox recovery remains available.
No stuck item is deleted to clear the dashboard.

## Validation and delivery

The full 41 compiled backend/MCP tests passed on Maxis at `13db89f`, after checking
host load and shared reservations. Minis passed lint and the focused lifecycle
checks, including native Git worktrees and path-containment regressions. CI then
exposed Windows drive-letter casing in the bare-root check. The fix uses platform
path equality after canonicalization, and the regression explicitly varies drive
casing. The focused checks passed again on Minis. Final CI remains the release
gate. No native steering capability is inferred from portable tests.

The deployed hub uses source runtime `ac75eb3` independently of the desktop app,
with the existing SQLite database backed up first. The verified snapshot contained
3,630 messages and 935 deliveries. Its SHA-256 is
`2B034DA16F9E37B85B8BDB466EFF613478F257009343B5C7AD05A0CE7C302355`.
The `ChatterBox Hub` user task starts at login. After a controlled child exit,
the same supervisor restarted the child from PID 24764 to PID 69348 and served
authenticated HTTP 200. Whole-machine reboot, logoff and parent-process recovery
were not exercised. No desktop installer or signed release was produced.

The Mac LaunchAgent and Minis/Maxis user tasks run the separate host companion.
Maxis also has a supervised SSH tunnel to the Minis hub. All three reported online
with trusted `ChatterBox` and `Fermenta` repository aliases. Launch authority is
currently restricted to this setup chat's exact canonical session and expires
within seven days. A different coordinator needs its own explicit enrollment;
ordinary session registration grants no launch authority.

The [deployment evidence](evidence/native-host-deployment-2026-10-26.json) records
successful native Codex and Claude runs on Mac and Maxis, including native IDs,
assistant readiness, final markers and failed attempts. Minis' two-provider proof
is [recorded separately](evidence/native-host-2026-10-25.json). These create
headless workers with owned worktrees, not desktop conversation windows.

The native Codex queue audit found five already accepted inputs in three older,
unloaded DeepTest chats. The installed provider exposes no supported promotion or
reconciliation operation for those rows. They were neither deleted nor replayed
into replacement sessions. The board audit separately found 485 mailbox and 18
queued unacknowledged deliveries; persistence is not model receipt. Verified
active-turn steering requires access to the actual owning shared runtime.

## Claude connection setup

The Windows Claude launcher now obtains a missing session ID from its genuine
owning native process, matching OS ancestor PIDs to `claude agents --json`.
It never chooses another active session by title, cwd or recency. The existing
Windows session `8bab26c8-9e55-4a2e-8501-22dfcac81079` reconnected and independently
completed help, registration, directed inbox, exact acknowledgement and reply.

Remote desktop verified the existing Mac Fermenta conversation. Its MCP reconnect
waited for the active turn to finish, then the genuine native session
`2afd083d-c520-42d9-9bf7-1e35f581f39a` registered as `mac-claude-2afd083d`.
The UI showed ChatterBox connected, and directed verification message
`msg_3a55fcf2-46de-4fa6-a1fd-0d26b287152e` was accepted. Model acknowledgement
remains a separate pending check. The Mac's in-progress draft was preserved.

Global Codex/Claude instructions were synchronized on Minis, Mac, Maxis and the
Fedora test VM. Ubuntu did not answer SSH from Minis or Mac; its synchronization
and MCP setup remain blocked by connectivity. No provider authentication tokens
were copied between hosts.

Native Claude creation uses each host's own CLI login, separately from the
desktop MCP connection. Normal provider OAuth login completed on Maxis. On Mac,
SSH login reported success but wrote the file fallback while a stale Keychain
record still shadowed it. Repeating native login in the GUI LaunchAgent context
resolved the observed failure, and the next headless worker completed. No saved
credential was removed and no existing Claude conversation was terminated.
