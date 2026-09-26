# Verification record

Date: 2026-09-26. Host: macOS. These are local capability probes, not application end-to-end tests. No ChatterBox daemon, MCP board, dashboard, Windows build, or Linux build exists yet.

## Codex 0.158.0 alpha desktop bundle

| Question                                                  | Observation                                                                                                                                                                                                                                       | Status                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Enumerate stored threads                                  | A separate app-server process completed `thread/list` with CLI, IDE, and app-server source filters and returned persisted threads.                                                                                                                | Verified locally                            |
| Distinguish loaded threads                                | `thread/loaded/list` returned separately from stored history; status is also present on thread objects.                                                                                                                                           | Verified locally                            |
| Stable native ID                                          | A disposable app-server thread retained the same UUID through three turns and `thread/read` returned its history.                                                                                                                                 | Verified locally                            |
| Map to desktop                                            | The same UUID appeared in the Codex desktop chat list; user-provided GUI screenshots show the successful turns in one visible conversation.                                                                                                       | Verified for the disposable thread          |
| Idle follow-up                                            | `turn/start` after completion produced `READY`, then `RECEIVED` on the same thread.                                                                                                                                                               | Verified locally and in GUI                 |
| Busy steering                                             | `turn/steer` returned the active turn ID, and the final response was `STEERED` after a requested eight-second shell wait.                                                                                                                         | Verified locally and in GUI                 |
| External injection into this active desktop conversation  | With the user's explicit request, a separate local app-server read this thread ID as `notLoaded`; `turn/steer` returned `thread not found`. The desktop app-server runs over its own stdio connection, and the default control socket was absent. | Failed through the separate-process route   |
| Shared app-server delivery                                | Two external WebSocket clients connected to one test app-server. Client B saw the loaded thread, steered Client A's active GPT-6 Sol turn, and the final reply was `SHARED`.                                                                      | Verified on a deliberately shared server    |
| CLI queue into this conversation                          | The desktop-bundled `codex queue` command accepted marker `CB-QUEUE-0926` for this thread, and the item exists in the queue database open by the desktop process. This turn has not completed, so native consumption is pending.                  | Queue acceptance verified; delivery pending |
| App-server queue method                                   | No queue method was found in the generated app-server schema. The CLI queue command is a separate surface.                                                                                                                                        | No method identified                        |
| Close, resume, interrupt, permissions, multi-client races | Protocol documents methods/events, but these cases were not exercised.                                                                                                                                                                            | Unverified                                  |

The first probes accidentally used a stale global CLI, version 0.154.0. It rejected `gpt-6-sol`, so an initial transport-only rerun used `gpt-5.5`. The user correctly pointed out that this desktop conversation uses GPT-6 Sol. Repeating the idle and busy probes with the desktop-bundled 0.158.0 alpha binary and `gpt-6-sol` completed successfully. The global standalone CLI was then updated to stable 0.157.1. Desktop and standalone versions must be recorded separately. The desktop screenshots supplied by the user show the earlier failed and successful attempts, and a later screenshot shows the shared-server `SHARED` reply. The native test-thread ID is useful for reproducing the experiment; it is not a portable identity for another machine.

An in-app `send_message_to_thread` call for the current conversation accepted a marker but did not establish that an independent local process can reach the desktop-owned active turn. A subsequent read of this turn showed the marker in the tool-call arguments, not as a new user-message item. UI automation could not be used because computer control of the Codex app is restricted in this environment. The product must therefore keep this route at `MAILBOX` until a supported external delivery path is proven.

Read-only filesystem inspection found a per-thread rollout file, state-database row, and writer-lock file for this conversation. The rollout modification time reflected recent work, and its latest event differed from a completed test rollout. Those are recency clues, not a reliable active-turn contract. A separate app-server still reported this desktop-owned thread as `notLoaded`. Session discovery should therefore use registration and provider lifecycle signals; file timestamps can only support a labelled last-activity hint.

Reproduction outline: start `codex app-server` over stdio, send `initialize` and `initialized`, call `thread/list`, create a disposable `thread/start` with a known supported model, issue `turn/start`, wait for `turn/completed`, issue a second turn, then start a delayed turn and call `turn/steer` with its `expectedTurnId`. Read back the thread. Repeat against the exact Codex version intended for release. The local prototype was intentionally kept outside the public repository.

## Claude Code 2.1.283

| Question                                        | Observation                                                                                                                                                          | Status             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Active session enumeration                      | `claude agents --json` returned active sessions with native `sessionId`, PID, current directory, and status. Existing sessions were only read.                       | Verified locally   |
| Authentication                                  | `claude auth status` returned `loggedIn: false`; a disposable `claude -p` call failed with an expired OAuth session before model work.                               | Blocked            |
| Channel registration and first event            | Current official docs describe it; no authenticated test session could run.                                                                                          | Unverified         |
| Twenty sequential events and busy-turn behavior | No authenticated test session could run.                                                                                                                             | Unverified         |
| Desktop-hosted Claude Code                      | Not tested separately.                                                                                                                                               | Unverified         |
| Protocol and policy                             | Official docs identify research-preview flags, channel allowlists, organization settings, and a protocol negotiation caveat. Installed behavior has not been tested. | Documentation only |

After Claude CLI authentication is restored, run a disposable channel server with a local authenticated sender path, send 20 numbered events into one session, check their order and acknowledgements, send another event during an active tool call, and repeat through desktop-hosted Claude Code. Do not use existing sessions for write probes without the session owner's authorization.

## Release gates

1. Observe whether the accepted `codex queue` item becomes a normal input in this conversation after the current turn, then test queueing against a disposable already-open desktop Codex conversation across restart and concurrent-client cases.
2. Complete Claude terminal and desktop channel tests, including 20 events and busy behavior.
3. Implement and exercise durable offline retry, deduplication, alias ambiguity, project isolation, and honest delivery status.
4. Build and inspect installers and a read-only dashboard on native macOS, Windows, and Linux hosts.
5. Validate each store and Homebrew artifact before claiming a distribution channel is available.

## Sources

- [Official OpenAI Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Official Claude Code Channels guide](https://code.claude.com/docs/en/channels)
- [Official Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference)
