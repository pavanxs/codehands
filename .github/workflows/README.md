# Continuous integration workflows

`ci.yml` runs the normal TypeScript, native-helper, and unit-test checks automatically on Windows and Ubuntu. Checkout includes the pinned `vendor/codex` submodule required by the native patch helper.

`macos-compatibility.yml` is manual-only. It runs one comprehensive macOS job when explicitly started from the Actions tab. The job:

- checks out the pinned Codex submodule;
- installs the pinned Codex CLI used by CodeHands;
- builds the repository once;
- runs the unit and native patch-helper tests;
- runs the real Codex correctness smoke;
- starts an isolated MCP server and runs the HTTP, new-tool, and form-elicitation suites;
- verifies structured patch rejection, real exec-server crash recovery, and live CLI log rendering;
- uploads no artifacts and creates no Cargo build cache.

The macOS workflow is intentionally excluded from push, pull-request, and scheduled triggers to avoid unnecessary runner usage.
