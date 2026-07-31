# ADR 002: Keep Codex as an untouched submodule

The \`vendor/codex\` path is an upstream Git submodule pinned to a known Codex
revision. Harness code cannot be added beneath that directory.

Upgrades move the submodule pointer, rebuild Codex, and run protocol contract
tests. A source patch is a design failure unless adopted upstream first.
