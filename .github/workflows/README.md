# Continuous integration workflows

`ci.yml` runs the lightweight TypeScript build and unit-test checks automatically on Windows and Ubuntu. It intentionally does not initialize the Codex submodule or compile the native Rust helper on every push.

`macos-compatibility.yml` is manual-only. It runs one comprehensive macOS job when explicitly started from the Actions tab. The job:

- checks out the pinned Codex submodule;
- installs the pinned Codex CLI used by CodeHands;
- runs TypeScript validation before any native compilation so ordinary failures stop cheaply;
- builds the native helper once with the stripped, non-optimized `ci` Cargo profile;
- runs the unit and native patch-helper tests;
- runs the real Codex correctness smoke;
- starts an isolated MCP server and runs the HTTP, new-tool, and form-elicitation suites;
- verifies structured patch rejection, real exec-server crash recovery, and live CLI log rendering;
- uploads no artifacts and creates no Cargo build cache.

Use `runtime` mode for the inexpensive real-Codex, HTTP, crash-recovery, elicitation, and live-log checks without compiling the native helper. Use `full` mode for the same checks plus the native helper build and patch/image integration.

The macOS workflow is intentionally excluded from push, pull-request, and scheduled triggers, uses no Cargo cache or uploaded artifacts, and has a 15-minute hard cap.
