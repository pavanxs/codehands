# Threat model

## Status

Implemented baseline for local pre-1.0 use. Public remote access remains out of
scope until an MCP-compatible OAuth gateway is implemented and reviewed.

## Assets

- Source code and repository history
- Files and credentials outside approved workspaces
- Terminal and local process access
- Local/private services and cloud metadata endpoints
- MCP bearer tokens and audit records

## Trust boundaries

1. MCP clients and all model-generated arguments are untrusted.
2. A valid MCP identity does not make a command or path safe.
3. CodeHands and Codex are separate processes joined by an experimental,
   pinned JSON-RPC contract.
4. A tunnel provides reachability and TLS, not CodeHands authorization.
5. Multiple MCP sessions sharing one executor must not share mutable state or
   process ownership.

## Controls

| Threat | Control |
| --- | --- |
| Public unauthenticated MCP access | Loopback binding, bearer authentication, host/origin checks |
| Brute force or request flooding | Fixed-window rate limit, request-size limit, session expiry |
| Directory traversal | Normalized containment against approved workspaces |
| Symlink escape | Canonical real-path containment for existing targets and deepest existing parent |
| Cross-project writes | One active workspace per MCP session |
| Cross-session process access | Session-owned process handle set |
| Shell injection | Direct argv execution; shell executables denied by default |
| Environment-based execution hijack | Environment allowlist; protected runtime keys always denied |
| Home-directory credential access | Child `HOME`/`USERPROFILE` is replaced with the active workspace |
| Dangerous commands | Sandbox is the primary control, with a configurable denylist as defense in depth |
| Unsandboxed executor | Sandbox context on every file/process request; process response must report a platform sandbox |
| SSRF and metadata access | HTTP disabled by default; HTTPS/method/host/DNS/private-network policy |
| Secret leakage in logs | Recursive key and command-argument redaction |
| Dependency confusion/new-package risk | Frozen lockfile, pinned toolchain, explicit install-script approval |
| Upstream protocol drift | Pinned submodule, compatibility check, deliberate update procedure |

## Residual risks

- Path validation has a time-of-check/time-of-use window. The Codex platform
  sandbox is the enforcing boundary if a filesystem entry changes after
  validation.
- An allowed executable can perform destructive operations inside its writable
  workspace. Use `allowedExecutables` and a disposable worktree where needed.
- Sandboxed commands receive a writable operating-system temporary directory.
  On macOS, Apple developer-tool and OpenSSL runtime directories are available
  read-only so Git and Node can start. Files outside those runtime locations
  and the active workspace remain outside the declared filesystem policy.
- Bearer authentication is suitable for local clients and an authenticated
  reverse proxy, but it does not implement the OAuth flow expected by all web
  MCP clients.
- DNS can change between validation and the executor's request. Outbound HTTP
  should remain disabled unless necessary, and allowed hosts should be narrow.
- `exec-server` remains experimental. `codehands doctor` and contract CI reduce
  but cannot eliminate upstream compatibility risk.

## Non-goals

- Exposing private model reasoning
- Acting as an autonomous coding agent
- Providing a general-purpose remote desktop
- Treating a command blacklist as a sandbox
