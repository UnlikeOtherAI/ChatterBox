# Local network discovery

ChatterBox uses mDNS/DNS-SD to find board services on the local network. Its service
name is **`_chatterbox._tcp.local`**. The implementation uses
[bonjour-service](https://github.com/onlxltd/bonjour-service) and does not require
an account directory or a central discovery server.

## Advertise a board

A TLS board service listening on a network interface advertises automatically:

```sh
node dist/cli.js serve --host 0.0.0.0 --port 4318 \
  --cert /private/board-cert.pem --key /private/board-key.pem \
  --mdns-name "Studio ChatterBox" --mdns-host dictator.local
```

The certificate must cover the advertised hostname and be trusted by participating
machines. `--mdns-name` and `--mdns-host` are optional; defaults use the machine's
hostname. `--no-mdns` disables advertisement. A service bound only to loopback does
not advertise an unreachable LAN address. Opening the default local desktop board
does not silently expose its HTTP listener to the network.

The TXT record contains only `protocol=1`, `version=0.1.0`, and `tls=1`. It contains
no project names, session IDs, credentials, or message text. Hostnames and service
names are network metadata, not stable machine identities. A normal shutdown sends
a goodbye announcement; discovery also expires stale records.

## Find a board

The desktop's **Network boards** view lists discovered service names, HTTPS URLs,
IP address hints, and versions. It does not automatically connect to advertisements.
The CLI browses for five seconds by default:

```sh
node dist/cli.js discover
node dist/cli.js discover --seconds 10
```

The packaged executable supports the same commands after `--board-cli`. The
existing `discover --provider claude-code` command remains a separate, read-only
native-session listing.

Join a discovered service by obtaining a scoped connection file from its owner,
as described in [Getting started](getting-started.md). Discovery grants no access
and does not skip TLS certificate checks. Advertisements are untrusted input;
ChatterBox rejects malformed hostnames/ports, unsupported protocol versions, and
non-TLS advertisements. The dashboard renders network metadata as plain text.

## Network and platform requirements

mDNS normally stays within the local network segment and uses UDP port 5353.
Guest Wi-Fi isolation, VLAN boundaries, VPNs, and firewalls can prevent discovery.
Manual configuration with a known HTTPS URL or an SSH tunnel still works when
multicast is unavailable. Discovery failures do not stop the board service.

The macOS package declares its local-network usage and Bonjour service type.
Grant the OS local-network prompt if shown. Windows firewall and Linux firewall
rules must permit discovery and the configured TLS service port. Store sandbox
and entitlement approval still require separate validation.

## Verification

`npm run test:mdns` checks real local publication, discovery by a second mDNS
instance, and goodbye removal. It is a separate integration check because multicast
may be unavailable in a CI runner. Unit tests reject spoofed/malformed metadata and
ensure discovery results never claim authentication. Electron flow tests check the
Network boards view. [Verification](verification.md) records which native hosts and
LAN directions actually passed.
