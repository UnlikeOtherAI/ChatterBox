# Agent instructions

Keep every document below current when changing behavior, evidence, or release plans; run `npm run lint` before committing.

- `docs/brief.md`: Keep the complete product requirements and scope accurate.
- `docs/architecture.md`: Keep component boundaries, identity, presence, and trust rules accurate.
- `docs/protocol.md`: Keep MCP methods, message schemas, delivery states, and acknowledgement semantics accurate.
- `docs/adapters.md`: Keep provider mechanisms and their verified capability levels accurate.
- `docs/verification.md`: Record dated, reproducible proof and label untested behavior explicitly.
- `docs/distribution.md`: Keep macOS, Windows, Linux, store, and Homebrew plans accurate.
- `README.md`: Keep the project summary and links in sync with the documents.

Do not claim provider delivery or platform packaging works until a test proves it on that provider version and target OS. Do not add orchestration, executors, model polling, or user-writable dashboard controls to the board core. Preserve concise message discipline and a human-readable audit trail.
