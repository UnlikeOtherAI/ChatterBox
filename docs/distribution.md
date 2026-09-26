# Desktop and distribution

ChatterBox uses Electron for the dashboard and Node.js for the service and MCP adapters. The source build targets macOS, Windows, and Linux. `npm run package` builds the configured direct packages on the native host: DMG/ZIP for macOS, NSIS for Windows, and AppImage/DEB for Linux. Electron includes its runtime; the same packaged executable exposes the CLI and MCP server with `--board-cli`, using its bundled runtime. The source CLI requires Node.js 24+.

The dashboard is read-only. It can start a local service or connect to an existing service. A daemon run with `node dist/cli.js serve` remains independent of the dashboard. Automatic installation as a login/background service is not implemented; choose an OS service manager explicitly when deploying the source CLI.

## Verification pipeline

The GitHub Actions matrix builds, lints, tests real SQLite and stdio MCP processes, runs Electron UI tests, and produces an unpacked application on macOS, Windows, and Linux. The Linux UI job uses Xvfb. Native host results and installer smoke tests are recorded in [Verification](verification.md). Tests and demo data use isolated directories.

Do not confuse an unpacked application build with signing, notarization, installer validation, or store review. Release artifacts must be built from a known Git revision, checksummed, and separately verified on their target OS.

## Target channels and remaining gates

| Platform | Planned channels                                                                              | Publication gate                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | Signed/notarized DMG and ZIP; Homebrew cask; Mac App Store if sandbox constraints can be met. | Developer ID and notarization credentials, Apple Silicon/Intel coverage, install/upgrade smoke test, Mac App Store sandbox/provider-access feasibility. |
| Windows  | Signed NSIS installer; Microsoft Store package.                                               | Publisher/signing identity, native install/upgrade smoke test, MSIX/store packaging and certification.                                                  |
| Linux    | AppImage/DEB; Flathub or Snap Store.                                                          | Target distribution install/upgrade smoke tests, desktop integration, sandbox/portal/provider-access feasibility, store manifest and review.            |

Store submission is not automated or approved by this initial implementation. Store sandboxes may constrain reading provider metadata, launching a local provider queue command, and running background services. Each channel needs a tested packaging design before it is advertised. Direct packages retain the full local adapter design.

A Homebrew cask should reference a tagged, signed, notarized macOS release artifact and its real SHA-256 checksum. Do not publish a placeholder URL or checksum. A separate formula becomes appropriate when the CLI distribution is published independently. No Homebrew package is published yet.

## Release checklist

- Build from a tagged revision on every native host and retain checksums and provenance.
- Verify fresh install, launch, shutdown, uninstall, data preservation, and upgrade from the previous schema.
- Verify signed macOS launch through Gatekeeper and notarization; verify the Windows publisher and installer identity.
- Verify source CLI and packaged dashboard use the documented `~/.chaterbox/data.db` location and preserve existing history.
- Verify provider delivery on the exact native provider releases and OS combinations before enabling those capabilities.
- Verify network loss/reconnection, backup/restore, credential revocation, and the retention/redaction policy.
- Submit only independently validated packages to their chosen stores; record acceptance separately from build success.

The macOS package declares `NSLocalNetworkUsageDescription` and `_chatterbox._tcp` in `NSBonjourServices`. Native firewall, local-network permission, and store-sandbox validation remain release checks for mDNS; see [Network discovery](network-discovery.md).
