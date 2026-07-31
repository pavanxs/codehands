# MCP Coding Harness — Implementation Design

## Purpose

This project is a thin MCP server that lets web AI assistants (ChatGPT, Claude
Chat) control your local machine step by step. The web AI is the brain; Codex
CLI is the executor. This layer sits between them as a router and policy gate.

Codex remains responsible for file I/O, terminal commands, sandboxing, Git
workflow, and safety. The harness owns MCP tool exposure, workspace policy,
audit records, and optional relay transport.

Communication with Codex: exec-server via JSON-RPC. The harness spawns the
exec-server as a child process and communicates through its JSON-RPC protocol.
It will not parse terminal text or reimplement Codex internals.

## Planned layout

    mcp-coding-harness/
    |-- README.md
    |-- SUMMARY.md
    |-- IMPLEMENTATION_DESIGN.md
    |-- package.json
    |-- pnpm-workspace.yaml
    |-- tsconfig.base.json
    |-- .gitmodules
    |-- apps/
    |   |-- local-agent/
    |   |   |-- README.md
    |   |   |-- src/
    |   |-- mcp-gateway/
    |       |-- README.md
    |       |-- src/
    |-- packages/
    |   |-- protocol/
    |   |-- mcp-tools/
    |   |-- codex-adapter/
    |   |-- policy-engine/
    |   |-- audit/
    |   |-- relay-client/
    |   |-- shared/
    |-- configs/
    |-- vendor/
    |   |-- codex/
    |-- docs/
    |   |-- adr/
    |-- scripts/
    |-- tests/
    |   |-- unit/
    |   |-- integration/
    |   |-- contract/
    |   |-- e2e/
    |-- .github/
        |-- workflows/

## Responsibilities

| Location | Responsibility |
| --- | --- |
| apps/local-agent | The CodeHands server. HTTP core (Streamable HTTP) serving MCP tool calls. Spawns and manages exec-server. Includes thin stdio adapter for clients that only support stdio. |
| apps/mcp-gateway | Hosted gateway — exposes the same server over a public endpoint via tunnel. V1 scope. |
| packages/codex-adapter | JSON-RPC client for exec-server. Spawns exec-server, manages connection, handles auto-restart (up to 3 retries). |
| packages/policy-engine | Workspace validation (approved paths from config), blocked commands list. |
| packages/mcp-tools | MCP tool schemas mirroring all exec-server operations (fs/readFile, fs/writeFile, process/start, etc.). |
| packages/protocol | Versioned shared schemas and types. |
| packages/audit | Redacted audit events. |
| packages/relay-client | Future authenticated relay to an MCP-compatible OAuth gateway; no direct public tunnels. |
| vendor/codex | Untouched OpenAI Codex upstream Git submodule. |
| configs | Example configuration, never credentials. |
| docs | Architecture, threat model, contracts, compatibility, decisions. |
| scripts | Bootstrap, build, and upstream-update scripts. |
| tests | Unit, integration, contract, and end-to-end tests. |

## Config

Location: `~/.codehands/config.json`

Contains:
- List of approved workspace paths
- Blocked commands list
- Server port (default TBD)
- Any future settings

Created automatically by `codehands init`. Edited in any text editor.

## Codex upstream boundary

The `vendor/codex` directory is an unmodified submodule pointing at the OpenAI
Codex repository. No harness source is placed inside it.

Upgrading means selecting a new upstream revision, rebuilding or selecting its
Codex executable, running compatibility tests, and committing only the changed
submodule pointer.

## MCP tools (16 total)

MCP spec only allows `[A-Za-z0-9_-.]` in tool names. We use underscore as
namespace separator and convert back to `/` for exec-server JSON-RPC calls.

| MCP tool name | exec-server method | What it does |
| --- | --- | --- |
| fs_readFile | fs/readFile | Read a file |
| fs_writeFile | fs/writeFile | Write a file |
| fs_createDirectory | fs/createDirectory | Create a directory |
| fs_readDirectory | fs/readDirectory | List directory contents |
| fs_walk | fs/walk | Walk directory tree |
| fs_remove | fs/remove | Delete file/directory |
| fs_copy | fs/copy | Copy file |
| fs_getMetadata | fs/getMetadata | Get file info |
| process_start | process/start | Run a command |
| process_read | process/read | Read command output |
| process_write | process/write | Send input to running command |
| process_terminate | process/terminate | Kill a command |
| process_signal | process/signal | Send signal to process |
| http_request | http/request | Fetch a URL |
| workspace_list | (CodeHands logic) | List approved workspaces |
| workspace_set | (CodeHands logic) | Set active workspace for session |

Design rules:
- **Granular, step-by-step** — the web AI controls each action individually.
- **No high-level task tools** — the web AI IS the agent loop; the server never
  runs an autonomous coding task.
- **Passthrough** — CodeHands adds workspace validation and blocked commands
  checking, then forwards directly to exec-server via JSON-RPC.
- **Naming** — underscore replaces slash for MCP compatibility.

## V1 Scope

V1 includes ALL of the following:
- All exec-server operations exposed as MCP tools
- HTTP core (Streamable HTTP) + stdio adapter
- Public hosted gateway (tunnel-agnostic)
- Workspace validation and blocked commands
- Auto-restart exec-server (up to 3 retries)
- Multi-client support (multiple AI chats simultaneously)
- Multi-workspace support (one shared exec-server)
- npm distribution with Codex bundled

## Delivery order

1. Core: exec-server spawning + JSON-RPC communication layer.
2. MCP tools: all exec-server operations exposed via Streamable HTTP.
3. Policy: workspace validation + blocked commands.
4. stdio adapter for Claude Desktop compatibility.
5. Hosted gateway: same HTTP server, exposed via tunnel.
6. Provider-specific connection guides for ChatGPT and Claude Chat.
