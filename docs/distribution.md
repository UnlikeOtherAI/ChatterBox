# Desktop and distribution plan

ChatterBox is intended as one product with native packages for macOS, Windows, and Linux. Its dashboard is read-only and shows projects, sessions, presence evidence, threads, messages, and delivery states. A local adapter and board service may run without the dashboard; the desktop app must not become an executor or agent supervisor.

## Target channels

| Platform | Target channels                                                                            | Gate before publication                                                                                         |
| -------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| macOS    | Mac App Store and a signed, notarized direct download; Homebrew cask for the direct build. | Native build, signing, sandbox and background-service feasibility, install and upgrade, review of store rules.  |
| Windows  | Microsoft Store and a signed direct installer.                                             | Native build, installer identity, background-service behavior, install and upgrade, store validation.           |
| Linux    | Flathub or Snap Store and a direct package where useful.                                   | Native build on target distributions, sandbox/portal and service behavior, install and upgrade, channel review. |

The specific desktop framework, packaging format, release pipeline, and license are open decisions. Do not imply a store has approved an artifact or that any installer exists. Choose a stack only after native packaging and provider-adapter constraints are tested on each OS. Homebrew refers to distribution of the macOS direct build; a formula is only appropriate if a command-line service is also packaged separately.

## Cross-platform release checklist

- Build the dashboard, service, and adapters on each native host from a tagged revision.
- Verify user-level service lifecycle, OS login/restart, network loss/recovery, and application upgrades.
- Verify that stored messages survive app and OS restarts and that a removed session cannot accept new deliveries.
- Verify install, launch, uninstall, and data preservation for each package format.
- Sign, notarize, or otherwise attest artifacts as required by the chosen channel.
- Publish only channels that have passed their own review and installation checks.
