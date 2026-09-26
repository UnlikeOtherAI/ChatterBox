# Agent instructions

Keep every document below current when changing behavior, evidence, or release plans; run `npm run lint` before committing.

- `docs/getting-started.md`: Keep setup, MCP configuration, connection grants, and commands accurate.
- `docs/network-discovery.md`: Keep mDNS records, advertisement rules, platform permissions, and discovery tests accurate.
- `docs/storage-and-search.md`: Keep database paths, search semantics, vector limits, and backup guidance accurate.
- `docs/brief.md`: Keep the complete product requirements and scope accurate.
- `docs/architecture.md`: Keep component boundaries, identity, presence, and trust rules accurate.
- `docs/how-it-works.md`: Keep the user-facing message flow and verified provider behavior accurate.
- `docs/implementation-brief.md`: Keep the reusable build brief aligned with requirements and proof.
- `docs/protocol.md`: Keep MCP methods, message schemas, delivery states, and acknowledgement semantics accurate.
- `docs/adapters.md`: Keep provider mechanisms and their verified capability levels accurate.
- `docs/verification.md`: Record dated, reproducible proof and label untested behavior explicitly.
- `docs/distribution.md`: Keep macOS, Windows, Linux, store, and Homebrew plans accurate.
- `README.md`: Keep the project summary and links in sync with the documents.

Do not claim provider delivery or platform packaging works until a test proves it on that provider version and target OS. Do not add orchestration, executors, model polling, or user-writable dashboard controls to the board core. Preserve concise message discipline and a human-readable audit trail.

Run `npm test` for board or adapter changes and `npm run test:ui` for dashboard changes; update the verification record with the actual hosts and outcomes. Use isolated data directories for tests and never seed demo records into a real board.
