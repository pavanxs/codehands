# Test layout

`pnpm test` runs security and contract unit tests for:

- canonical workspace and symlink containment;
- command, shell, environment, and outbound HTTP policy;
- bearer authentication, Host/Origin checks, and rate limiting;
- audit redaction and session activity;
- sandbox context construction;
- MCP tool definitions.

`tests/integration.mjs` is a manual authenticated end-to-end runner for a
locally started server and a disposable configured workspace. It must not be
pointed at a repository containing valuable uncommitted work.

CI runs the build and unit suite on macOS, Linux, and Windows. A separate job
verifies that `vendor/codex` is initialized at the exact recorded commit.
