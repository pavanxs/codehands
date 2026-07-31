# CodeHands

CodeHands is a thin, policy-controlled MCP bridge between a web AI assistant
and OpenAI Codex's local `exec-server`.

The AI remains the agent loop. CodeHands exposes atomic file, process, Git,
HTTP, workspace, and activity tools; validates every request; forwards allowed
operations to the pinned Codex executor; and returns structured results.

## Security status

CodeHands is pre-1.0 software. Local testing is supported. A narrowly scoped
capability URL is available for temporary, single-user remote testing.

- HTTP binds to `127.0.0.1` and requires a bearer token by default.
- Every file and process request includes a workspace sandbox. Startup fails if
  the selected exec-server cannot prove that a platform sandbox was applied.
- Workspace checks resolve symlinks, including the existing parent of a file
  that is about to be created.
- Processes, active workspaces, and process handles are isolated per MCP
  session.
- Commands execute as an argv array without implicit shell interpretation.
  Shell executables and environment overrides are denied by default.
- Outbound HTTP is disabled by default. When enabled it requires an allowlist
  and blocks private, loopback, link-local, and metadata destinations.
- Tool calls are written to a recursively redacted JSONL audit log.

Tailscale Funnel, ngrok, and Cloudflare Tunnel make a local service reachable
from the public internet. A tunnel is not application authentication. For
single-user testing, CodeHands can put a 256-bit random capability in the MCP
path. The unguessable path is then the credential. Multi-user or production
deployments still require an MCP-compatible OAuth gateway.

See [SECURITY.md](SECURITY.md) and [docs/threat-model.md](docs/threat-model.md).

## Architecture

```text
ChatGPT / Claude / MCP client
            |
      MCP tool calls
            |
CodeHands HTTP or stdio server
  - authentication and limits
  - per-session state
  - workspace/command/network policy
  - audit activity
            |
       JSON-RPC
            |
Pinned Codex exec-server
  - filesystem operations
  - sandboxed processes
```

CodeHands never modifies `vendor/codex`. The submodule commit is the protocol
contract. Do not automatically update it: update deliberately and run the
contract and sandbox tests.

## Prerequisites

- Node.js 22
- pnpm 10.10
- Git
- Rust/Cargo when building the pinned Codex executor

## Installation

```bash
git clone --recurse-submodules https://github.com/pavanxs/codehands.git
cd codehands
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm codex:check
pnpm codex:build
cd apps/local-agent
npm link
cd ../..
codehands init
```

`pnpm codex:build` prints the absolute path to the compatible Codex binary.
Put that path in `~/.codehands/config.json` as `codexBinary`.

The globally installed `@openai/codex` package is not automatically assumed to
be protocol-compatible. `codehands doctor` detects incompatible versions and
missing sandbox support.

## Configuration

`codehands init` creates:

- `~/.codehands/config.json`, mode `0600`
- `~/.codehands/http-token`, a random bearer token, mode `0600`
- `~/.codehands/capability-token`, a separate random URL credential, mode `0600`

Example:

```json
{
  "workspaces": [
    "C:/Users/you/projects/my-app"
  ],
  "port": 3100,
  "host": "127.0.0.1",
  "auth": {
    "enabled": true,
    "tokenEnv": "CODEHANDS_AUTH_TOKEN"
  },
  "capabilityPath": {
    "enabled": false,
    "tokenEnv": "CODEHANDS_CAPABILITY_TOKEN"
  },
  "allowedHosts": [
    "localhost",
    "127.0.0.1",
    "::1"
  ],
  "allowedOrigins": [],
  "maxRequestBytes": 1048576,
  "rateLimitPerMinute": 120,
  "sessionTtlMs": 1800000,
  "blockedCommands": [],
  "allowedExecutables": [],
  "allowedEnvironmentVariables": [],
  "allowShell": false,
  "http": {
    "enabled": false,
    "allowedHosts": [],
    "allowedMethods": ["GET", "HEAD"],
    "allowHttp": false,
    "allowPrivateNetwork": false
  },
  "codexBinary": "C:/absolute/path/to/pinned/codex.exe"
}
```

An empty `allowedExecutables` list permits executables subject to the other
policies. Add entries to turn it into an allowlist. Environment overrides are
denied unless their names appear in `allowedEnvironmentVariables`; protected
runtime variables such as `PATH`, `HOME`, and `NODE_OPTIONS` cannot be
overridden.

## Commands

```text
codehands init      Create config and an HTTP bearer token
codehands doctor    Verify config, exec-server compatibility, and sandboxing
codehands start     Start authenticated Streamable HTTP on loopback
codehands stdio     Run as a stdio MCP server
codehands logs -f   Follow sanitized tool activity
codehands capability-url <host-or-mount-url>  Print the secret HTTPS MCP URL
codehands rotate-capability      Replace a disclosed capability token
```

Run `codehands doctor` before connecting a client.

The capability URL is intended only for personal testing. It does not disable
bearer authentication on `/mcp`, and the capability token is deliberately
different from the local bearer token. Treat the full generated URL like a
password.

## Tools

CodeHands exposes 22 atomic tools:

- Files: read, write, exact replacement, unified patch, text search, list,
  walk, metadata, create, copy, and remove
- Processes: start, read, write, interrupt, and terminate
- Git: status and diff
- Workspaces: list and select for the current session
- HTTP: policy-controlled request, disabled by default
- Activity: recent sanitized calls, durations, and failures

`process_start` never invokes a shell. Use:

```json
{
  "command": "npm",
  "args": ["test"]
}
```

Do not put `npm test` in the `command` field.

## Multiple chats

One HTTP server may serve multiple chats. Each MCP session owns its active
workspace and process handles. A chat cannot read, signal, or terminate a
process started by another session.

## Observability

Audit logs are stored in `~/.codehands/logs/YYYY-MM-DD.jsonl`. Values under
content, bodies, headers, environment variables, tokens, passwords, cookies,
and common secret arguments are redacted.

Use `codehands logs -f` locally or ask the AI to call `activity_recent`. This
shows actual tool calls, durations, outcomes, and errors. It does not expose a
model's private reasoning.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

CI runs type checks, the build, and the security/unit suite on macOS, Linux,
and Windows, and checks that the Codex submodule matches the recorded commit.

Licensed under Apache-2.0.
