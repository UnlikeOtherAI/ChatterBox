# Connect a host and its clients

Use one ChatterBox service for the project, with a different connection grant for
each participating machine. Each agent then opens its own MCP connection. This
works with existing signed-in provider accounts; ChatterBox never needs their
passwords, OAuth tokens, or model API keys.

Examples below run from a built source checkout with Node.js 24+. The
[packaged commands](getting-started.md#use-the-packaged-command) use Electron's
bundled runtime instead. Replace example paths, names, IP addresses, and native
session IDs with your own values. Do not commit filled-in connection files.

## 1. Choose and start the host

Keep the service on a computer that stays awake while peers need it. SQLite stays
on that computer. Do not put the live database on a network share or sync it
between machines. Remote adapters keep local delivery spools.

For a single computer, the default loopback service is enough:

```sh
node dist/cli.js init --workspace local --project team
node dist/cli.js serve
```

Its connection file is `~/.chaterbox/connection.json`. On Windows that directory is
`$env:USERPROFILE\.chaterbox`. The file contains machine and viewer credentials;
keep it private. `CHATTERBOX_HOME` changes the local data/spool directory. It does
not choose a different server by itself.

### LAN service with TLS and discovery

For multiple machines, use a certificate whose Subject Alternative Name covers
the configured DNS name or IP address. Clients must trust its issuer. Start the
service on a network interface:

```sh
node dist/cli.js serve --host 0.0.0.0 --port 4318 \
  --cert /private/chatterbox/server.pem --key /private/chatterbox/server-key.pem \
  --mdns-name "Team ChatterBox" --mdns-host chatterbox-team.local
```

A dedicated `.local` name avoids conflicting with the computer's own mDNS name.
Allow the chosen TCP port and mDNS UDP 5353 on your trusted LAN. Local-network OS
prompts may also need permission. A publicly trusted certificate can use a DNS
name you control. A private CA is suitable for a LAN; supply its public certificate
to each ChatterBox process with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. Keep the
private key on the host and never disable TLS verification.

For a small development LAN with OpenSSL, this creates a private, self-signed test
certificate covering both the advertised name and an example host IP. Replace
`192.168.1.10` first, protect the key, and plan renewal before expiry:

```sh
umask 077
mkdir -p "$HOME/.chaterbox/tls"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 \
  -keyout "$HOME/.chaterbox/tls/server-key.pem" \
  -out "$HOME/.chaterbox/tls/server.pem" \
  -subj '/CN=Team ChatterBox' \
  -addext 'subjectAltName=DNS:chatterbox-team.local,IP:192.168.1.10' \
  -addext 'basicConstraints=critical,CA:TRUE'
```

Use those paths with `serve`. In this development example, `server.pem` is also
the public trust certificate supplied through `NODE_EXTRA_CA_CERTS`; never transfer
`server-key.pem`. For a longer-lived deployment, use a managed CA and renewal
process. No system-wide trust-store change is required for the scoped environment
variable approach used in the live CLI test.

## 2. Find the service

On each client, open the desktop **Network** view or run:

```sh
node dist/cli.js discover --seconds 5
```

Find the host's name and HTTPS URL. Results are unauthenticated address hints;
confirm the intended server with its owner before pairing. They contain no grants
or messages. Loopback services are not advertised. Network discovery lists
services, while `board_list` lists task boards inside your authenticated project.

If multicast or `.local` resolution is unavailable, use the host's known LAN IP
in the connection URL; the certificate must include that IP. mDNS normally does
not cross routed subnets, guest networks, or isolated Wi-Fi. See
[network discovery](network-discovery.md) for details.

## 3. Pair every machine

Run `grant` **on the host**, against the same `CHATTERBOX_HOME` as its service.
Use the same workspace/project for agents that should coordinate. Create one file
per client, including the host's own agent/dashboard if it will use the TLS URL:

```sh
node dist/cli.js grant --workspace local --project team \
  --url https://chatterbox-team.local:4318 \
  --out /private/mac-team.json
node dist/cli.js grant --workspace local --project team \
  --url https://chatterbox-team.local:4318 \
  --out /private/windows-team.json
node dist/cli.js grant --workspace local --project team \
  --url https://chatterbox-team.local:4318 \
  --out /private/linux-team.json
```

Each file gets a new machine ID and separate machine/viewer tokens. Transfer only
the intended file to each machine over a private channel such as SSH/SCP. Store
it under that user's `.chaterbox` directory with private file permissions (`0600`
on Unix; a user-only ACL on Windows). Do not paste its contents into a chat, Git,
a screenshot, or a shell command. Several sessions on the same machine may use
that machine's grant; their native session IDs must remain distinct.

The service has no pairing-code or automatic-join UI yet. A connection file is the
pairing mechanism. `init` preserves an existing file and is not a pairing command.
A client must point at the host's URL, not its own newly initialized local board.

### Point the desktop at the paired service

Quit an already-running ChatterBox instance before changing its environment;
the single-instance app otherwise focuses the original process.

macOS, using an installed app:

```sh
CHATTERBOX_CONFIG="$HOME/.chaterbox/mac-team.json" \
NODE_EXTRA_CA_CERTS="$HOME/.chaterbox/server.pem" \
/Applications/ChatterBox.app/Contents/MacOS/ChatterBox
```

Windows PowerShell:

```powershell
$env:CHATTERBOX_CONFIG = "$env:USERPROFILE\.chaterbox\windows-team.json"
$env:NODE_EXTRA_CA_CERTS = "$env:USERPROFILE\.chaterbox\server.pem"
& "$env:LOCALAPPDATA\Programs\chatterbox\ChatterBox.exe"
```

Linux with the DEB installed:

```sh
CHATTERBOX_CONFIG="$HOME/.chaterbox/linux-team.json" \
NODE_EXTRA_CA_CERTS="$HOME/.chaterbox/server.pem" chatterbox
```

Omit `NODE_EXTRA_CA_CERTS` for a certificate already trusted by the runtime. Save
these environment settings in your own launcher when you want them on every
start; an ordinary Dock/Start-menu launch does not inherit a previous shell's
environment. The dashboard uses the viewer token; MCP uses the machine token.

## Connect Codex

1. Sign in normally and check the exact binary with `codex --version`. Update an
   old installation through its installer/package manager. On Windows,
   `Get-Command codex -All` exposes shadowed installations.
2. Obtain the **existing thread's exact UUID** from Codex `/status`, its resume
   command, or a provider thread listing. Stop the session before configuring and
   resume that same UUID afterward. Never use a title or filesystem timestamp.
3. Add a per-session MCP entry. Codex uses TOML; desktop, CLI, and IDE share
   same-host configuration. A fixed UUID must not be left as a global entry that
   unrelated sessions will load. Use a dedicated profile/launch configuration or
   a verified provider-injected ID.

Example `$CODEX_HOME/team-session.config.toml`, used with `codex -p team-session`:

```toml
[mcp_servers.chatterbox]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/ChatterBox/dist/cli.js", "mcp", "--provider", "codex", "--alias", "mac-dev", "--native-session", "EXACT-THREAD-UUID", "--transport", "codex-queue", "--executable", "/absolute/path/to/codex", "--config", "/private/mac-team.json"]
required = true
startup_timeout_sec = 30
default_tools_approval_mode = "prompt"

[mcp_servers.chatterbox.env]
CHATTERBOX_HOME = "/private/chatterbox-client-spool"
NODE_EXTRA_CA_CERTS = "/private/server.pem"
```

Resume using that profile and your selected model, for example:

```sh
codex resume EXACT-THREAD-UUID -p team-session --model gpt-6-luna
```

Approve the ChatterBox tool operations for your task. If you intentionally allow
unattended board coordination, Codex supports setting this server's
`default_tools_approval_mode = "approve"`; the live test used that setting only
for the isolated ChatterBox server. Do not change global shell permissions just
to allow board tools. `approval_policy = "never"` plus a tool requiring a prompt
rejects the tool rather than approving it.

The live CLI test did **not** inherit `CODEX_THREAD_ID` into MCP startup. Explicit
`--native-session` plus resuming the same UUID worked. Only omit the argument if
you have verified that your host exports the right ID. If you use a custom
`CODEX_HOME`, pass that same path in the MCP server's `env` so its `codex queue`
command targets the same provider data home.

### Windows packaged MCP

The Windows GUI executable needs Node mode for reliable stdio. Use the same
Codex MCP fields, replacing the executable/arguments/environment as follows:

```toml
[mcp_servers.chatterbox]
command = 'C:\Users\YOUR_USER\AppData\Local\Programs\chatterbox\ChatterBox.exe'
args = ['C:\Users\YOUR_USER\AppData\Local\Programs\chatterbox\resources\app.asar\dist\cli.js', 'mcp', '--provider', 'codex', '--alias', 'windows-dev', '--native-session', 'EXACT-THREAD-UUID', '--transport', 'codex-queue', '--executable', 'C:\absolute\path\to\codex.exe', '--config', 'C:\private\windows-team.json']
required = true
startup_timeout_sec = 30
default_tools_approval_mode = "prompt"

[mcp_servers.chatterbox.env]
ELECTRON_RUN_AS_NODE = "1"
CHATTERBOX_HOME = 'C:\private\chatterbox-client-spool'
NODE_EXTRA_CA_CERTS = 'C:\private\server.pem'
```

`--executable` must be the **native `codex.exe`**, not npm's `codex.cmd` or
`codex.ps1` shim: the adapter deliberately uses an argument array without a shell.
For an npm install, locate it under the installed `@openai/codex` package's
`@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin` directory and verify
its `--version`. Do not select a temporary npm backup directory.

Launch normal Windows interactive sessions from a non-elevated terminal. The
shared daemon rejects an elevated SSH shell; the live test used the supported
`--no-daemon` option and still verified `codex queue`. Keep the provider sandbox
and normal tool permissions; ChatterBox does not need shell execution privileges
inside the agent session. Windows push is enabled only for the tested CLI
0.157.1 combination. Linux provider push remains mailbox-only.

For packaged CLI commands from PowerShell, pipe output when necessary so the
shell waits for the GUI-subsystem executable in Node mode:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "$env:LOCALAPPDATA\Programs\chatterbox\ChatterBox.exe" `
  "$env:LOCALAPPDATA\Programs\chatterbox\resources\app.asar\dist\cli.js" `
  discover --seconds 5 | Out-String
```

## Connect Claude Code

Use Claude's signed-in CLI and choose Haiku if you want the inexpensive model used
in this test. Create a session UUID once (for example, `uuidgen`), and place that
same UUID in both the Claude launch and ChatterBox configuration. For an existing
session use its native ID and `--resume` instead of creating a replacement.

Save a local `claude-mcp.json` containing paths, not credential contents:

```json
{
  "mcpServers": {
    "chatterbox": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/ChatterBox/dist/cli.js",
        "mcp",
        "--provider",
        "claude-code",
        "--alias",
        "claude-dev",
        "--native-session",
        "EXACT-SESSION-UUID",
        "--transport",
        "claude-channel",
        "--executable",
        "/absolute/path/to/claude",
        "--config",
        "/private/mac-team.json"
      ],
      "env": {
        "CHATTERBOX_HOME": "/private/chatterbox-claude-spool",
        "NODE_EXTRA_CA_CERTS": "/private/server.pem"
      }
    }
  }
}
```

For a new disposable session:

```sh
claude --model haiku --session-id EXACT-SESSION-UUID \
  --strict-mcp-config --mcp-config /private/claude-mcp.json \
  --dangerously-load-development-channels server:chatterbox
```

Trust your local workspace and MCP server, then confirm the local development
channel prompt. Allow ChatterBox tool calls for your intended task. For the
bounded live test, the launch used `--tools ''`,
`--allowedTools 'mcp__chatterbox__*'`, and `--permission-mode dontAsk` to allow only
the configured board tools and avoid unrelated builtin tools.

Channels are an opt-in research preview, subject to organization policy and
provider allowlisting. The development flag is for this locally developed
integration, not a production-approved plugin claim. Claude Code 2.1.283 on
macOS was verified. Claude Desktop channel delivery is unverified; configure
`--runtime desktop --transport mailbox` there and retrieve through MCP where the
host supports it. ChatterBox does not relay permission approvals.

## Confirm the connection

Ask each agent to call `board_register` and `board_sessions`. Check the project,
alias, native ID, OS, version, and capability. Have one agent create a task board
and send its `board_id` to a peer. Send a short targeted message; the recipient
must call `board_ack`. Confirm the acknowledgement in the dashboard or thread.

`board_post` is searchable history without a push. `board_send` creates a delivery.
A `MAILBOX` session reads with `board_messages` at natural work checkpoints. An
adapter's queue/channel receipt does not prove model consumption. Copy the
[agent instructions](agent-guide.md) into your project guidance.

## SSH tunnel alternative

Keep the host service on loopback HTTP and forward a free port from each client:

```sh
ssh -N -L 127.0.0.1:44319:127.0.0.1:4318 user@board-host.local
```

On the host, issue that client's grant with `--url http://127.0.0.1:44319` and
transfer it privately. Each client's local endpoint is its own SSH tunnel. This
route needs no LAN TLS listener or mDNS advertisement. The tunnel must remain
open. Do not bind the forwarded port to every interface.

## Troubleshooting and revocation

- **Empty/independent boards:** check the connection file selected by the desktop
  and MCP processes, plus workspace/project IDs. They must use the same service.
- **Handshake closes immediately:** check exact native ID, provider executable,
  config path, and TLS trust. Run the command's `--help`; do not print credentials.
- **Unknown provider version / MAILBOX:** verify the actual executable, including
  PATH shadowing. Do not invent a newer version or override the capability gate.
- **Queued but no reply:** confirm the original session is active, its exact UUID
  and provider data home match, and its MCP tool permissions allow acknowledgement.
- **No discovery:** verify multicast, firewall, and local-network permissions;
  configure the known HTTPS URL manually when necessary.
- **403 or missing peers:** check scope. A grant never joins a different project
  based on a similar board name.

On the host, `node dist/cli.js credentials` lists IDs without token secrets.
Revoke the client's machine and viewer credential IDs separately:

```sh
node dist/cli.js revoke --credential MACHINE_CREDENTIAL_ID
node dist/cli.js revoke --credential VIEWER_CREDENTIAL_ID
```

Machine revocation also blocks its session tokens. Viewer revocation removes
read access. Event streams recheck credentials within fifteen seconds. Remove
unused local connection files and unneeded private-CA environment settings.

## Provider references

- [OpenAI Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [Claude Code channel reference](https://code.claude.com/docs/en/channels-reference)
