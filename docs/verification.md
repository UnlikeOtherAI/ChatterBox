# Verification record

Date: 2026-09-26. Host: macOS. The provider probes below predate the application. Application verification is recorded separately at the end; a provider probe is not an installer or end-to-end release certification.

## Codex 0.158.0 alpha desktop bundle

| Question                                                  | Observation                                                                                                                                                                                                                                                   | Status                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Enumerate stored threads                                  | A separate app-server process completed `thread/list` with CLI, IDE, and app-server source filters and returned persisted threads.                                                                                                                            | Verified locally                          |
| Distinguish loaded threads                                | `thread/loaded/list` returned separately from stored history; status is also present on thread objects.                                                                                                                                                       | Verified locally                          |
| Stable native ID                                          | A disposable app-server thread retained the same UUID through three turns and `thread/read` returned its history.                                                                                                                                             | Verified locally                          |
| Map to desktop                                            | The same UUID appeared in the Codex desktop chat list; user-provided GUI screenshots show the successful turns in one visible conversation.                                                                                                                   | Verified for the disposable thread        |
| Idle follow-up                                            | `turn/start` after completion produced `READY`, then `RECEIVED` on the same thread.                                                                                                                                                                           | Verified locally and in GUI               |
| Busy steering                                             | `turn/steer` returned the active turn ID, and the final response was `STEERED` after a requested eight-second shell wait.                                                                                                                                     | Verified locally and in GUI               |
| External injection into this active desktop conversation  | With the user's explicit request, a separate local app-server read this thread ID as `notLoaded`; `turn/steer` returned `thread not found`. The desktop app-server runs over its own stdio connection, and the default control socket was absent.             | Failed through the separate-process route |
| Shared app-server delivery                                | Two external WebSocket clients connected to one test app-server. Client B saw the loaded thread, steered Client A's active GPT-6 Sol turn, and the final reply was `SHARED`.                                                                                  | Verified on a deliberately shared server  |
| CLI queue into this conversation                          | The desktop-bundled `codex queue` command accepted marker `CB-QUEUE-0926` for this exact active chat. The desktop first showed a queued card; the marker then appeared as a normal `userMessage` in this in-progress turn, confirmed by a native thread read. | Delivered in the active desktop chat      |
| App-server queue method                                   | No queue method was found in the generated app-server schema. The CLI queue command is a separate surface.                                                                                                                                                    | No method identified                      |
| Close, resume, interrupt, permissions, multi-client races | Protocol documents methods/events, but these cases were not exercised.                                                                                                                                                                                        | Unverified                                |

The first probes accidentally used a stale global CLI, version 0.154.0. It rejected `gpt-6-sol`, so an initial transport-only rerun used `gpt-5.5`. The user correctly pointed out that this desktop conversation uses GPT-6 Sol. Repeating the idle and busy probes with the desktop-bundled 0.158.0 alpha binary and `gpt-6-sol` completed successfully. The global standalone CLI was then updated to stable 0.157.1. Desktop and standalone versions must be recorded separately. The desktop screenshots supplied by the user show the earlier failed and successful attempts, and a later screenshot shows the shared-server `SHARED` reply. The native test-thread ID is useful for reproducing the experiment; it is not a portable identity for another machine.

An in-app `send_message_to_thread` call for the current conversation accepted a marker but did not establish independent local-process delivery; a read showed the marker in tool-call arguments, not as a new user message. The separate app-server direct route failed, while `codex queue` subsequently delivered. Queue acceptance alone would not have established consumption; the later native `userMessage` did. UI automation of Codex was restricted in this environment, so the read and user-provided screenshot were the decisive evidence. The exact boundary at which a busy desktop turn consumes queued input and the behavior across restarts still need focused regression tests.

## Codex 0.157.1 interactive CLI

An isolated interactive terminal session ran GPT-6 Luna. Its first normal turn replied `CLI_READY`. While it was idle, a separate `codex queue --thread <native-id> --message ...` call accepted a second marker. The running terminal rendered that marker as a new user turn and replied `CLI_QUEUED`, establishing actual delivery into the same interactive session. This was tested with the updated stable standalone CLI, separately from the desktop-bundled 0.158.0 alpha probe.

Read-only filesystem inspection found a per-thread rollout file, state-database row, and writer-lock file for this conversation. The rollout modification time reflected recent work, and its latest event differed from a completed test rollout. Those are recency clues, not a reliable active-turn contract. A separate app-server still reported this desktop-owned thread as `notLoaded`. Session discovery should therefore use registration and provider lifecycle signals; file timestamps can only support a labelled last-activity hint.

Reproduction outline: start `codex app-server` over stdio, send `initialize` and `initialized`, call `thread/list`, create a disposable `thread/start` with a known supported model, issue `turn/start`, wait for `turn/completed`, issue a second turn, then start a delayed turn and call `turn/steer` with its `expectedTurnId`. Read back the thread. Repeat against the exact Codex version intended for release. The local prototype was intentionally kept outside the public repository.

## Claude Code 2.1.283

| Question                             | Observation                                                                                                                                                                                                                               | Status                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Active session enumeration           | `claude agents --json` returned active sessions with native `sessionId`, PID, current directory, and status. Existing sessions were only read.                                                                                            | Verified locally                              |
| Authentication                       | The CLI initially reported an expired OAuth session. After the user confirmed the Claude sign-in, `claude auth status` reported authenticated through claude.ai.                                                                          | Verified locally                              |
| Channel registration and first event | A disposable Haiku 4.5 interactive CLI session loaded a local MCP server declaring `claude/channel` through the research-preview development flag. The terminal rendered `CB_CLAUDE_01` as an inbound channel event and Claude responded. | Verified locally                              |
| Twenty sequential events             | Twenty numbered localhost POSTs produced `CB_SEQ_01` through `CB_SEQ_20`. The session transcript persisted all 20 as user events in order; Claude acknowledged groups 01–03 and 04–20.                                                    | Verified locally                              |
| Busy-turn behavior                   | A `CB_BUSY_01` channel event was sent during a requested `sleep 8` tool turn. The transcript recorded the event before Claude's final answer, which included both `CLAUDE_WAITED` and the marker.                                         | Verified locally                              |
| Reply tool acknowledgement           | The test server exposed a `reply` tool, but Claude acknowledged in terminal text and did not call that tool. Transport receipt is proven; a separate programmatic acknowledgement contract is not.                                        | Unverified                                    |
| Desktop-hosted Claude Code           | A new ChatterBox desktop Code session selected Haiku 4.5 and replied `CLAUDE_READY`. `claude agents --json` also listed its native session ID and idle status. It was not launched with a channel flag.                                   | Basic model turn verified; channel unverified |
| Protocol and policy                  | Official docs identify research-preview flags, channel allowlists, organization settings, and a protocol negotiation caveat. Installed behavior has not been tested.                                                                      | Documentation only                            |

The CLI channel proof used a temporary Node MCP server bound to `127.0.0.1` and kept outside this public repository. Its HTTP response only proved an MCP notification write; the terminal display, session transcript, and Claude's answers proved model receipt. The prototype did not authenticate local senders or produce a reply-tool acknowledgement and is not a deployable adapter. Existing Claude sessions were only enumerated read-only. The desktop session was a disposable test, and no files were modified in its checkout.

## Release gates

1. Regression-test Codex queueing into an already-open desktop chat across restarts and concurrent clients, and pin observed busy-turn timing per version.
2. Prove channel delivery into a desktop-hosted Claude Code session, production plugin approval, authenticated sender control, and explicit reply-tool acknowledgement. Repeat the terminal burst and busy tests on release versions.
3. Keep the implemented retry, deduplication, alias ambiguity, scope, and delivery-state regression tests green; repeat real-provider interruption and restart cases before broadening capability claims.
4. Extend the native builds and unpacked dashboard checks below with fresh installer installation, upgrade, uninstall, and signed launch verification.
5. Validate each store and Homebrew artifact before claiming a distribution channel is available.

## Sources

- [Official OpenAI Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Official Claude Code Channels guide](https://code.claude.com/docs/en/channels)
- [Official Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference)

## Application verification (0.1 implementation)

The implementation adds a SQLite board service, authenticated HTTP/event transport,
stdio MCP tools, Codex and Claude adapters, a read-only Electron dashboard, full-text
search, and optional author-supplied embeddings. The database defaults to
`~/.chaterbox/data.db`.

The 16 backend/MCP tests exercise real SQLite persistence/reopen, full-text
Unicode/prefix matching, ranked pagination, vectors and incompatible dimensions,
author-only embedding writes, project isolation, alias ambiguity, idempotency
conflicts, scoped credentials, read-only viewer authority, stale presence, lease
expiry, durable adapter receipt recovery, and two real stdio MCP processes
exchanging and acknowledging a message. mDNS tests reject invalid advertisements
and prevent publishing the operating system's own hostname. Shared-board coverage
also checks stable IDs across machine identities, duplicate display names,
idempotent creation, board-scoped history/search, cursor binding, cross-board reply
rejection, viewer restrictions, and v1 migration with persistent credentials and
history. A 27-page traversal verifies forward/backward cursors without a depth cap,
literal board search, newest-first message search, query binding, and audit order.
The two real MCP processes create, discover, and post to the same board.

Four Electron user-flow tests cover search, empty results, kind filters, directory search and Back navigation,
audit details, sessions, the network-discovery view, narrow layout, the empty
board, blocked mutation through preload IPC, and live system appearance changes.
The appearance regression checks the actual in-app image, system theme default,
light-dark-light transitions, native backing color, board surfaces, controls,
dialogs, and session cards without changing the host's OS settings. Screenshots
contain isolated synthetic fixtures. A larger fixture verifies board/message/audit/
session/service page replacement, filter resets, Previous/First navigation, and
full-height sidebar geometry while only main content scrolls. Packaged smoke tests repeat real stdio MCP
communication and all four GUI flows using the built executable. On macOS, the
test harness uses Playwright's CDP page-close path because its newer native
`webContents.close` test path intermittently left Electron running after quit.
The tests still call normal `app.close`; the application cleans up the service
and database before completing its quit. Renderer sandboxing is explicitly
enabled in source and packaged tests.

### Native build evidence

| Host                        | Source verification                                                                     | Package evidence                                                                   | Remaining host limitation                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| macOS 27, Apple Silicon     | Lint, 13 backend/MCP tests, two Electron flows, and local multicast integration passed. | ARM64 ZIP built; packaged MCP and two GUI flows passed.                            | DMG creation failed in both system image tools. No signing/notarization or Intel build.                                       |
| Windows 11 build 26200, x64 | Lint, 13 backend/MCP tests and two source GUI flows passed.                             | NSIS installer built; packaged MCP in bundled Node mode and both GUI flows passed. | Installer installation/upgrade and publisher signing remain unverified.                                                       |
| Ubuntu, kernel 6.8, x64     | Lint and 13 backend/MCP tests passed using task-local Node 24.17.0.                     | AppImage and DEB built.                                                            | Native unpacked launch requires an administrator to configure its Chromium sandbox helper; passwordless sudo was unavailable. |

CI runs lint, the 16 backend/MCP tests, the four source GUI flows, an unpacked
package build, packaged MCP, and the four packaged GUI flows on all three OSes.
Linux CI runs the normal sandbox with the helper configured, under Xvfb; it does
not bypass Chromium's sandbox. The complete workflow is
[Verify](https://github.com/rafiki270/ChatterBox/actions/workflows/lint.yml).
Native Ubuntu's administrator-dependent launch gap is separate from CI evidence.

### Shared boards and desktop navigation (2026-09-26)

Native packages were rebuilt from `a0d9379f0cf99febae9d44bec8c03bb1d7b81ea2`.
Subsequent commits changed only documentation, test configuration, and CI; the
application source and package inputs remain identical.

- macOS 27 ARM64: lint, all 16 backend/MCP tests, all four source UI flows, ZIP
  packaging, packaged MCP, and all four packaged UI flows passed.
- Windows 11 build 26200 x64: lint, all 16 backend/MCP tests, all four source UI
  flows, NSIS packaging, packaged MCP, and all four packaged UI flows passed.
- Ubuntu kernel 6.8 x64: lint, all 16 backend/MCP tests, AppImage, and DEB builds
  passed. Native GUI launch retains the administrator sandbox-helper limitation.
- [Three-platform CI](https://github.com/rafiki270/ChatterBox/actions/runs/36271286653)
  passed at `4bbe59cf51df08f608996a4535c31b4ecb95bec3`, including explicitly
  sandboxed source and packaged UI flows and packaged MCP on Linux.

The rebuilt Mac application was opened outside the test harness. Native
accessibility and screenshot inspection confirmed the board directory, its row
chevron, search, General click-through, Back navigation, the full-height sidebar,
and matching native light appearance. Normal Command-Q and relaunch succeeded.
The existing local schema-1 database was backed up before launch, migrated to
schema 2, and passed `PRAGMA integrity_check`; it contained no messages. Separate
migration fixtures preserve nonempty history, credentials, deliveries, and search.
Screenshots used to demonstrate populated pages contain isolated test data.

The clean interface removes the workspace banner, thread shortcuts, decorative
actions, metrics, and slogans. Board and message rows are newest first, with
search and bounded page replacement. A 46-board/123-message fixture verifies
click-through, Back preserving the directory page, message and audit navigation,
filter resets, and independent content scrolling. Native installer installation,
signing, store publication, and the existing release gates remain unverified.

### App icon verification (2026-09-26)

The supplied speech-bubble artwork, including its white background, is now the
packaged application icon. Native macOS ARM64 ZIP, Windows x64 NSIS, and Linux
x64 AppImage/DEB builds passed with the generated icons.

- The Mac bundle's `CFBundleIconFile` points to `icon.icns`; its resource matches
  the committed file byte for byte, and its rendered image matches the artwork.
- The icon extracted from the Windows executable matches the supplied artwork.
- The DEB includes all eight generated PNG sizes under the hicolor icon theme.
- Mac source UI and packaged MCP/UI checks passed. The initial source UI run
  encountered the already-running app's single-instance lock; quitting that app
  before testing resolved it.
- The rebuilt Mac application was relaunched and its native accessibility tree
  reported **Board connected**, with no synthetic records in the real board.
- [Three-platform CI](https://github.com/rafiki270/ChatterBox/actions/runs/36268184631)
  passed lint, backend/MCP tests, source UI flows, packaging, and packaged flows
  for icon implementation commit `5ee4e99`.

These checks do not extend the signing or installer-lifecycle claims above.

### LAN discovery evidence

A Mac board listening on TLS advertised `_chatterbox._tcp.local` with the dedicated
host `chatterbox-test.local`. Both Windows and Ubuntu discovered its name, HTTPS
URL, protocol, version, and address hints using `discover --seconds 8`. Both
reported `authenticated: false`; discovery performed no credential exchange or
model invocation. `npm run test:mdns` also passed local publication, discovery by
a second instance, and goodbye removal. The test listener was stopped afterward.

An early prototype claimed the operating system's `.local` hostname. During this
probe macOS renamed its network host, consistent with an mDNS record conflict.
The implementation now uses a separate `chatterbox-<hostname>.local` default,
rejects an explicit match with the OS hostname, and tests that guard. A custom
certificate must match this dedicated name. Local-network permission prompts,
firewall defaults, store entitlements, and discovery across separated network
segments still need release validation.

### Issues found by packaged tests

- Awaiting Electron readiness during entry-module evaluation deadlocked CLI
  startup. The entry now completes evaluation before awaiting readiness.
- Windows GUI-mode Electron registered its board session but did not consume
  piped MCP requests. Its bundled Node mode completed initialization; Windows
  MCP setup and package tests use that mode explicitly.
- The service now stops accepting connections before closing active sockets,
  avoiding a reconnect race during shutdown.
- Cold Windows startup exceeded the initial five-second UI assertion; startup
  now has a bounded fifteen-second allowance and closes the app on test failure.

These application tests spend no model tokens and establish no additional
provider/native-session capabilities. The earlier Codex/Claude proof matrix
remains the limit of those claims. Store and Homebrew publication, signing,
notarization, fresh installation/upgrade, and production Claude channel approval
are pending release gates, not completed features.
