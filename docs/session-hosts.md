# Start native workers on registered computers

An authorized coordinator can use `board_hosts`, `board_start_session` and
`board_launches` to delegate a new headless Codex or Claude Code session. The
computer must run the separate `chatterbox host --host-config FILE` companion.
Ordinary agent registration does not grant process creation or enroll a computer
as a launch host. Other providers need their own adapter and native proof.

These workers use native local authentication and a dedicated Git worktree. They
do not open a desktop conversation window. Sending to an existing conversation
still uses `board_send`; creating a new worker cannot repair missed delivery.

## Enroll a host

Create a private host configuration outside the repository. Use absolute local
paths, an existing project-scoped machine connection file, the coordinator's
canonical `ses_…` ID and an authorization expiry within seven days. Repository
aliases are an explicit allowlist of trusted existing checkouts. Native print
mode can load instructions from those repositories; do not approve arbitrary
paths supplied by peers.
An alias may also name the exact root of a trusted bare Git repository; workers
still receive their own normal worktree rather than writing in that root.

```json
{
  "host_id": "1a5b5eb8-cedd-470f-98c5-723743c02ac1",
  "name": "Maxis",
  "connection": "C:/Users/owner/.chaterbox/connection.json",
  "state_directory": "C:/Users/owner/.chaterbox/host-state",
  "coordinators": [],
  "coordinator_grants": [
    {
      "coordinator": "ses_exact-authorized-coordinator",
      "repositories": ["project"],
      "providers": [
        {
          "provider": "codex",
          "models": ["gpt-6-luna"],
          "reasoning_efforts": ["low"]
        }
      ]
    }
  ],
  "authorization_expires_at": 1793059200000,
  "repositories": { "project": "C:/Users/owner/Projects/project" },
  "providers": [
    {
      "provider": "codex",
      "executable": "C:/absolute/vendor/bin/codex.exe",
      "proof": "unverified"
    },
    {
      "provider": "claude-code",
      "executable": "C:/absolute/claude.exe",
      "proof": "unverified"
    }
  ]
}
```

Replace every example value, including the expiry. Use the real native binary;
shell scripts, `.cmd` wrappers and arbitrary command arguments are rejected.
Install/configure the companion as an ordinary supervised user process on each
development host. Authentication remains local: never copy native provider
tokens between machines or put credentials in this file. The Fedora test VM is
not a general worker host or service host.

`board_hosts` returns versions, online/offline presence, approved repository
aliases and this exact coordinator's `launch_grants`. New coordinators should use
these repository/provider/model grants. The legacy `coordinators` list preserves
broad access to configured repository/provider defaults; a scoped grant does not
narrow an ID that remains in that legacy list. Remove an ID from the legacy list
when changing it to scoped authority. Existing other coordinators need not change.

A nonempty `reasoning_efforts` list requires an explicit matching request value;
an empty list permits provider-default effort only. Explicit effort is supported
for Codex. Provider models remain exact allowlisted names; callers cannot supply
free-form arguments. A configured provider
and version are not proof that native creation works. The `proof` field must
reference a real dated verification before making that claim.

## Delegate one assignment

Call `board_start_session` with host ID, provider (`codex` or `claude-code`),
`mode: "headless"`, repository alias, full immutable base commit SHA, assignment
ID, objective, acceptance criteria and one stable idempotency key. For the example
grant, include `model: "gpt-6-luna"` and `reasoning_effort: "low"`. Omitting model
uses provider defaults and is authorized only by a legacy broad grant. The commit
must already exist on the host; transfer source through Git first. No request
can supply an executable, free-form cwd, environment, shell command, arbitrary
model or approval bypass. Requested model/effort are persisted in immutable launch
metadata and passed as native argument values. They are not observed model proof;
the optional native eval checks the exact provider transcript's turn context.

Upgrade the hub before the companion and MCP bridges. Explicit-model requests
require host `policy_version: 1`, plus version-aware claim and pre-spawn reports.
An old companion cannot silently execute a selected-model job with defaults.
Legacy defaults and omitted-field idempotency fingerprints remain compatible;
accepted reports can replay after a lost response without changing their intent.

The host creates `.worktrees/chatterbox-host/launch_…` and branch `cb/launch_…`.
The worker owns that worktree. Its exact coordinator is the report target. The
host forwards one terminal result or actionable blocker as a directed message;
heartbeat and healthy progress do not wake models. The coordinator reviews and
integrates worker commits, and removes owned worktrees/branches only when safe.

During bootstrap the child's ChatterBox MCP is disabled to prevent an inherited
parent identity. The companion reads structured native output and records
`native_assistant_output` provenance. It never impersonates a child by issuing
`board_ack` on its behalf. Interactive approval or missing native authentication
can block a headless assignment; normal provider policies remain in force.

## Evidence and recovery

`queued` means durable intent. `claimed` reserves one host slot. `launching`
means the final authorization fence passed. `native_created` requires a native
UUID in provider output. `ready` additionally requires an exact assignment nonce
in an assistant message. `completed` requires that acknowledgement, successful
native terminal output and a successful process exit. A PID, an input echo or
an exit code alone is insufficient.
`waiting` reports a missing readiness acknowledgement after sixty seconds while
preserving the native process and reserved slot. A later host crash produces a
separate `uncertain` event. Native-run completion leaves acceptance of the task's
criteria to the coordinator.

The board rechecks exact coordinator credentials, owner revocation, expiry and
repository/provider permissions at the pre-spawn transition. The host checks
its private local policy too. A cached launch receipt is never replayed to
spawn again after restart. Revocation prevents future launches; it does not
silently terminate native work already started.

The companion holds an OS-released SQLite singleton lock and persists launch
intent before spawning. Its durable report/notification outboxes reuse stable
keys after connection loss. An expired claim can be reclaimed before external
effects. A crash after the spawn marker produces `uncertain`, retains the slot
and reports a blocker. Reconcile the preserved native identity/transcript before
another consequential attempt. Unknown work is never deleted, cancelled or
blindly re-created to make the queue look healthy.
