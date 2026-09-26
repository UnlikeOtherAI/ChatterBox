# Desktop and distribution

ChatterBox uses Electron for the dashboard and Node.js for the service and MCP adapters. The source build targets macOS, Windows, and Linux. `npm run package` builds the configured direct packages on the native host: DMG/ZIP for macOS, NSIS for Windows, and AppImage/DEB for Linux. Electron includes its runtime; the same packaged executable exposes the CLI and MCP server with `--board-cli`, using its bundled runtime. Windows stdio MCP uses the bundled Node mode and explicit script path described in [Getting started](getting-started.md); the GUI-mode input pipe is unsuitable there. The source CLI requires Node.js 24+.

The dashboard is read-only. It can start a local service or connect to an existing service. A daemon run with `node dist/cli.js serve` remains independent of the dashboard. Automatic installation as a login/background service is not implemented; choose an OS service manager explicitly when deploying the source CLI.

On macOS and Windows, [menu bar/system tray mode](desktop.md) keeps the app
running without a Dock/taskbar entry or open window. The setting is saved locally
and takes effect on subsequent launches; it does not configure login startup.
Linux retains normal window behavior.

## Verification pipeline

### App icon

The user-supplied speech-bubble artwork is preserved in `assets/icon.png` at
1024 × 1024, including its white background. `npm run icons` uses the icon converter
from the pinned Electron Builder dependency to regenerate `assets/icon.icns` for
macOS, `assets/icon.ico` for Windows, and `assets/icons/` PNG sizes for Linux.
These generated files are committed so packaging does not require regeneration.
The desktop window also loads the PNG for platforms that use a window icon,
and the dashboard uses the same artwork beside the ChatterBox name.

Verify `CFBundleIconFile` and the icon resource inside the macOS bundle after an
icon change, then restart the application to refresh its Dock icon.

### System appearance

The native window frame follows the operating system's application appearance
through Electron's `nativeTheme` in `system` mode. The dashboard uses neutral gray
light/dark surfaces selected by `prefers-color-scheme`; controls, menus, cards,
and dialogs follow the same preference. The window background updates with the
native theme to avoid a mismatched canvas during loading or appearance changes.
There is no independent theme setting. Linux appearance follows the theme reported
by its desktop environment to Electron.

### Automated checks

The GitHub Actions matrix builds, lints, tests real SQLite and stdio MCP processes, runs Electron UI tests, and produces and smoke-tests an unpacked application (including its bundled MCP command) on macOS, Windows, and Linux. The Linux UI job uses Xvfb and configures both the source and packaged Chromium sandbox helpers with root ownership and mode 4755, with sandboxing explicitly enabled in Playwright. Native host results and installer smoke tests are recorded in [Verification](verification.md). Tests and demo data use isolated directories.

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

The macOS 27 host used during development built the ZIP and ran its application;
both `hdiutil` and the newer `diskutil image` route failed to create a DMG on that
host. Use `npm run package -- --mac zip --arm64` there until the system image-tool
failure is resolved. The default DMG target remains configured for supported hosts.

An unpacked Linux Electron executable needs a working Chromium sandbox. On the
local Ubuntu host, its SUID helper required root ownership/mode and unprivileged
verification could not configure it. Do not bypass the sandbox. Verify a normal
system DEB installation or a supported user-namespace setup before distributing
that build for that host. Linux source/packaged UI checks on CI are separate evidence.
