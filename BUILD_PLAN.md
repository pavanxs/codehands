# Build Plan — What We Build vs What Codex Handles

## The Core Principle

**CodeHands never touches the user's workspace directly.**

Every file read, file write, directory listing, and terminal command goes
through Codex exec-server. CodeHands is purely a mediator — it receives
requests from AI clients, validates them, and passes them to exec-server.

```text
AI client → CodeHands (validate + route) → exec-server (actually does the work)
```

CodeHands has no file system access of its own. No process spawning of its own.
No Git operations of its own. It only talks to exec-server via JSON-RPC. The
exec-server is the one with hands on the machine.

---

## Already Built by Codex (we just use it)

### File System Operations

| exec-server method | What it does |
| --- | --- |
| fs/readFile | Read a file's contents |
| fs/writeFile | Create or overwrite a file |
| fs/createDirectory | Create directories (with parents) |
| fs/readDirectory | List a folder's contents |
| fs/walk | Recursively walk a directory tree |
| fs/remove | Delete a file or folder |
| fs/copy | Copy a file |
| fs/getMetadata | Get file size, timestamps, permissions |

### Process Management

| exec-server method | What it does |
| --- | --- |
| exec (process/start) | Spawn a command, return process ID |
| exec_read (process/read) | Read stdout/stderr from a running process |
| exec_write (process/write) | Send stdin input to a running process |
| terminate (process/terminate) | Kill a process |
| signal (process/signal) | Send OS signal (SIGINT, SIGTERM, etc.) |

### Infrastructure (handled by exec-server)

- JSON-RPC protocol (request/response/notification)
- PTY support (interactive terminals)
- Real-time process output streaming (notifications)
- Process exit detection and reporting
- File system sandboxing (restricts access to allowed paths)
- Network sandboxing (controls outbound network)
- Windows platform support (ConPTY, Windows sandbox)
- Linux platform support (bubblewrap/bwrap)
- Session persistence (30-second retention on disconnect)
- Concurrent process management (multiple processes running)

**We do NOT rebuild any of this. We just call it.**

---

## What We Build (CodeHands)

### 1. Codex Adapter — `packages/codex-adapter/`

Talks to exec-server. This is our JSON-RPC client.

| What to build | Detail |
| --- | --- |
| Spawn exec-server | Start `codex exec-server` as child process on startup |
| JSON-RPC client | Send requests, receive responses over stdio pipe |
| Notification handling | Receive process output/exit events from exec-server |
| Auto-restart | Detect exec-server crash, respawn (up to 3 times) |
| Connection state | Track connected/disconnected/restarting status |

### 2. MCP Tools — `packages/mcp-tools/`

Defines what AI clients can call. 15 tools total.

| What to build | Detail |
| --- | --- |
| 13 passthrough tools | One MCP tool per exec-server operation (same names) |
| list_workspaces | Returns approved workspace list from config |
| set_workspace | Sets active workspace for this client session |
| Parameter schemas | JSON Schema for each tool's inputs |
| Result formatting | Format exec-server JSON-RPC responses as MCP results |
| Tool annotations | Mark each tool as read-only or destructive |

### 3. Policy Engine — `packages/policy-engine/`

Security gate between AI and exec-server.

| What to build | Detail |
| --- | --- |
| Workspace validation | Reject any path not inside an approved workspace |
| Path resolution | Convert relative paths to absolute (using active workspace) |
| Blocked commands list | Reject dangerous commands (rm -rf /, format C:, etc.) |
| Config integration | Read workspace list and blocked commands from config |

### 4. MCP Server (HTTP Core) — `apps/local-agent/`

The actual server process. Heart of CodeHands.

| What to build | Detail |
| --- | --- |
| Streamable HTTP transport | MCP protocol over HTTP (per MCP spec) |
| Multi-client support | Handle 3-4 simultaneous AI connections |
| Session management | Per-client state (active workspace, session ID) |
| Request routing | tool call → policy check → codex adapter → response |
| Server lifecycle | Port binding, graceful shutdown |

### 5. stdio Adapter — inside `apps/local-agent/`

For clients that only support stdio (like Claude Desktop).

| What to build | Detail |
| --- | --- |
| stdio ↔ HTTP bridge | Read MCP from stdin → forward to HTTP core → write to stdout |

~20 lines of glue code.

### 6. CLI

User-facing commands.

| What to build | Detail |
| --- | --- |
| `codehands start` | Start HTTP server + spawn exec-server |
| `codehands init` | Create default ~/.codehands/config.json |

### 7. Config Management

Settings and preferences.

| What to build | Detail |
| --- | --- |
| Load config | Read ~/.codehands/config.json on startup |
| Schema validation | Ensure config structure is correct |
| Default creation | Generate config with sensible defaults if none exists |

### 8. Audit — `packages/audit/`

Logging what happens.

| What to build | Detail |
| --- | --- |
| Tool call logging | What was called, by which session, params |
| Result logging | Success/failure, timing |
| Redaction | Don't log file contents — just paths and outcomes |

### 9. Hosted Gateway — `apps/mcp-gateway/`

Remote access from anywhere.

| What to build | Detail |
| --- | --- |
| Same HTTP server, exposed publicly | Port forwarded via tunnel |
| Tunnel documentation | How to set up Tailscale Funnel |
| Auth middleware (v2) | Token-based auth for remote connections |

### 10. Protocol + Shared — `packages/protocol/`, `packages/shared/`

Types and utilities.

| What to build | Detail |
| --- | --- |
| TypeScript types | Tool params, results, config schema, errors |
| Shared utilities | Error formatting, logging helpers, constants |

---

## Build Order (recommended)

| Phase | What | Why first |
| --- | --- | --- |
| 1 | Codex adapter (spawn + JSON-RPC) | Foundation — nothing works without this |
| 2 | MCP tools (all 15 schemas) | Define the interface AI clients will use |
| 3 | Policy engine (workspace + blocked commands) | Security before exposure |
| 4 | HTTP core (Streamable HTTP MCP server) | The actual server AI clients connect to |
| 5 | CLI (start + init) | User-facing entry point |
| 6 | stdio adapter | Claude Desktop support |
| 7 | Audit logging | Visibility into what's happening |
| 8 | Hosted gateway + tunnel docs | Remote access |

---

## Effort Summary

| Layer | Codex provides | We build |
| --- | --- | --- |
| Actual file operations | All 8 ops | Nothing (passthrough) |
| Actual process operations | All 5 ops | Nothing (passthrough) |
| Sandboxing | Full (file + network + process) | Nothing (trust Codex) |
| MCP protocol | Nothing | Full server implementation |
| Security | Sandbox enforcement | Workspace validation + blocked commands |
| Multi-client | Nothing | Session management |
| CLI | Nothing | start/init commands |
| Config | Nothing | Full config system |

The heavy lifting (file I/O, processes, sandboxing, cross-platform) is done
by Codex. We build the thin, fast routing layer on top.
