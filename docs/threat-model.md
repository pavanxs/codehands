# Threat model

## Status: Not yet decided

The specific security constraints and threat mitigations have not been finalized.
They will be determined during implementation.

## Known assets to protect

- Files inside workspaces
- Git credentials, API tokens, and browser sessions
- Audit records

## Known trust boundaries

1. MCP inputs from web AIs are untrusted, even when from an authenticated chat.
2. Codex is a separate process with its own safety mechanisms.
3. The thin layer never makes coding decisions — it only routes and validates.

## Undecided

- Exact path validation rules
- Whether shell access is restricted or exposed
- Sandboxing approach
- Relay transport security model
- Browser automation policy
