# Security policy

## Supported versions

CodeHands is pre-1.0 software. Security fixes are applied to the latest commit
on `main`; there are no supported release branches yet.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose files,
credentials, terminal access, or an MCP authentication token. Use GitHub's
private vulnerability reporting for this repository when it is enabled, or
contact the repository owner privately.

Include the affected commit, operating system, reproduction steps, impact, and
any suggested mitigation. Please allow a reasonable remediation window before
public disclosure.

## Security boundaries

- HTTP mode binds to loopback and requires a bearer token by default.
- A tunnel does not provide application authentication. Do not publish the MCP
  endpoint unless an authenticated gateway supported by the MCP client is in
  front of it.
- File and process operations must include a Codex workspace sandbox. CodeHands
  fails closed when exec-server reports no platform sandbox.
- Workspace validation resolves symlinks before allowing an operation.
- Outbound HTTP is disabled by default and uses explicit protocol, method, host,
  DNS, and private-network policy when enabled.
- Shell interpreters and environment overrides are denied by default.

The Codex `exec-server` protocol is experimental and version-sensitive.
Production use must use the pinned submodule revision and pass
`codehands doctor`.
