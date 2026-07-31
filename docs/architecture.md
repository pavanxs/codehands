# Architecture

## Product boundary

CodeHands is a thin, policy-controlled MCP server that gives web AI assistants
(ChatGPT, Claude Chat) step-by-step control over your local development machine.

The web AI is the brain — it decides what to read, edit, and run. Codex
exec-server is the executor — it performs the actual file I/O, terminal
commands, and sandboxing. CodeHands is the router and policy gate between them.

```text
Web AI (ChatGPT / Claude)
  │ MCP tool calls (Streamable HTTP or stdio)
  ▼
CodeHands (TypeScript, HTTP core)
  │ authenticates, rate-limits, isolates sessions
  │ validates workspace + command + network policy
  │ JSON-RPC
  ▼
Codex exec-server (lean Rust process)
  │ reads/writes files, runs commands, sandboxes
  ▼
Local filesystem / terminal
```

The web AI sends individual tool calls (read file, edit file, run command). This
server never runs an autonomous agent loop.

## Transport

**HTTP core (Streamable HTTP)** is the primary transport. One CodeHands server
instance handles multiple AI clients simultaneously on multiple workspaces.

**stdio adapter** wraps the HTTP core for clients that only support stdio (e.g.,
Claude Desktop). The adapter connects internally to the HTTP server.

## Access modes

- **Local (HTTP on localhost):** Primary mode. Multiple AI chats connect to one
  server. ~1-3ms latency overhead.
- **Local (stdio adapter):** For stdio-only clients. Wraps HTTP core internally.
- **Remote personal testing:** A separately generated 256-bit capability path
  may be exposed through an HTTPS tunnel for one trusted user.
- **Remote shared/production:** Requires a separately reviewed MCP-compatible
  OAuth gateway.

## Components

| Component | Responsibility | Must not do |
| --- | --- | --- |
| Local agent (HTTP core) | Hosts MCP tools, handles multiple concurrent AI connections, spawns/manages exec-server | Run its own agent loop |
| stdio adapter | Wraps HTTP core for stdio-only clients | Duplicate server logic |
| Policy engine | Validates paths against approved workspaces, enforces blocked commands | Authorize arbitrary paths |
| Codex adapter | JSON-RPC client for exec-server. Spawns it, manages connection, auto-restarts (3 retries) | Parse terminal text |
| MCP tools | All exec-server ops exposed as MCP tools (fs/readFile, fs/writeFile, process/start, etc.) | Add autonomous logic |
| `vendor/codex` | Unmodified upstream source, used as live executor | Contain harness modifications |

## Workspace handling

One shared exec-server serves multiple MCP sessions. Each session owns its
active workspace and process handles. CodeHands resolves symlinks and validates
that every requested path stays inside the session's active approved workspace
before forwarding to exec-server. Config lives at
`~/.codehands/config.json`.

## Execution lifecycle (single tool call)

1. The web AI calls an MCP tool (e.g. `fs/readFile` with path `src/app.ts`).
2. CodeHands resolves the full path and checks it against approved workspaces.
3. CodeHands applies command/environment or outbound-network policy.
4. The codex adapter forwards the JSON-RPC call to exec-server.
5. Exec-server executes the operation (reads file, runs command, etc.).
6. The result returns through the adapter → CodeHands → back to the web AI.

Each operation is independent. The web AI decides the next step based on what
it received. This server does not chain operations or make coding decisions.

## Error recovery

CodeHands spawns exec-server as a child process. They share a fate:
- If anything crashes, restart everything (`codehands start` again).
- If exec-server dies mid-session, CodeHands auto-restarts it up to three
  times. Running handles become invalid and clients receive structured errors.
- Running processes are lost on crash — the AI simply restarts them.

## Safety model

- **Workspace validation:** Canonical paths and existing parent directories
  must remain inside the active workspace.
- **Command execution:** argv is forwarded without an implicit shell.
- **Exec-server sandbox:** Every operation carries a workspace permission
  profile. Unsandboxed process responses are terminated and rejected.
- **Outbound HTTP:** Disabled by default and allowlisted when enabled.
- **Session isolation:** Workspace and process ownership are per session.
- **No API key:** exec-server is purely local. No cloud calls, no credentials.
- **HTTP boundary:** Loopback binding, bearer authentication, host/origin
  checks, request limits, rate limits, and session expiry are enabled.
