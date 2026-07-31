# Scripts

- `check-codex.mjs` verifies that the initialized submodule exactly matches the
  recorded gitlink and has no local modifications.
- `build-codex.mjs` verifies the submodule, then builds the pinned `codex`
  executable with Cargo's locked dependency graph.

Neither script updates the submodule. Upstream updates must be deliberate PRs
with protocol, sandbox, and cross-platform verification.
