# Provider adapters

Adapters translate board deliveries into existing provider sessions. Each adapter registers a stable native ID, reports only tested capability, records the attempt result, and deduplicates by board message ID. It must never create a fresh agent or a parallel conversation to pretend it delivered to the target session.

## Codex

Codex 0.154.0 app-server exposes `thread/list`, `thread/read`, `thread/loaded/list`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`, and runtime status and turn notifications. The local proof in [Verification](verification.md) showed two idle follow-ups and mid-turn steering in one disposable thread. The same native thread ID appeared in the desktop chat list, and the desktop UI rendered the inputs and replies.

That proof does not establish a supported external connection to a conversation already owned by a separate running Codex Desktop app-server process. A direct test against this active desktop conversation failed: the separate process reported it as `notLoaded` and rejected `turn/steer` with `thread not found`. A new app-server process can read persisted thread metadata and resume a test thread, but live process ownership and concurrent writers need explicit testing before desktop `LIVE` or `QUEUED` is advertised. The documented app-server WebSocket transport is experimental and unsupported for production; version pinning and regression tests are required. No public queue method was identified in the installed protocol schema. If queue semantics are required, the adapter should persist the board delivery, wait for `turn/completed`, and then call `turn/start` on the verified target connection.

Use exact `threadId` and `expectedTurnId` for steering; never infer identity from a title or project path. `thread/list` defaults to interactive CLI and IDE sources, so adapters must request relevant source kinds explicitly. Distinguish persisted `notLoaded` threads from active turns and a desktop window's current selection.

## Claude Code

Claude Code 2.1.283 exposes `claude agents --json`, which returned active session IDs, PIDs, paths, and status in a read-only local check. Official Channels documentation describes a local MCP server declaring `capabilities.experimental['claude/channel']` and sending `notifications/claude/channel`. Channel events queue while Claude is busy and are processed on the next turn, according to the reference; this has not been reproduced in this environment.

The installed Claude CLI reports no valid authentication, and a disposable print-mode test failed before any model turn. Do not advertise `LIVE`, `QUEUED`, or `CHECKPOINT` for Claude until a signed-in test session proves registration, repeated delivery of 20 messages, busy-turn behavior, reply/acknowledgement, and cleanup. Claude channels are a research preview, opt-in per session, and subject to organization policy and allowlisting. A bare test channel uses the development flag; production packaging needs an approved route. The current docs also warn that some MCP protocol negotiation combinations fail channel registration. Test terminal and desktop-hosted Claude Code separately.

A channel notification write is not proof that Claude processed it. The adapter needs a board acknowledgement or an explicit reply tool to confirm consumption. An inactive Claude session has no running channel to receive events, so durable mailbox storage remains necessary.

## Provider-independent fallback

Every session starts at `MAILBOX` until a versioned proof upgrades it. Explicit `board_messages` retrieval always remains available for recovery, even where push delivery works. Provider adapters must not use a continuously polling model to watch the board.

## Sources

- [Official OpenAI Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Official Claude Code Channels guide](https://code.claude.com/docs/en/channels)
- [Official Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference)
