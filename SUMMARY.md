# Discussion Summary

All confirmed decisions for the CodeHands (MCP Coding Harness) project.

---

## 1. Core Goal

Build a thin MCP server called **CodeHands** that connects web AI assistants
(ChatGPT, Claude Chat) to your local development machine. The web AI controls
everything step by step — it is the brain. This server provides the hands.

---

## 2. Roles and Boundaries

- **Web AI (ChatGPT / Claude Chat):** Makes all coding decisions. Sends
  individual tool calls: read file, edit file, run command. It IS the agent
  loop.
- **CodeHands (this MCP server):** Routes each tool call to Codex, enforces
  workspace policy, audits activity. Never runs its own agent loop.
- **Codex exec-server (background process):** Executes the actual file I/O,
  terminal commands, sandboxing, and safety. Already handles all the hard
  low-level work.

---

## 3. Confirmed Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript | MCP SDK is TS-first, fast to iterate, I/O-bound layer doesn't need Rust speed |
| Communication with Codex | exec-server via JSON-RPC | Provides granular step-by-step ops (fs/readFile, process/start, etc.) |
| Transport | HTTP core + stdio adapter | HTTP for multi-client + hosted; stdio adapter for Claude Desktop |
| MCP tools | Mirror exec-server operations (passthrough) | Don't redesign what Codex already structured |
| Architecture | Web AI = brain, CodeHands = router, exec-server = executor | Clear separation of concerns |
| Codex usage | Untouched Git submodule, never modify | Free upgrades when OpenAI updates Codex |
| Access modes | Both local (HTTP) + hosted (tunnel) | V1 includes both |
| Target providers | ChatGPT + Claude Chat | Both from the start |
| UI | None (JSON config file) | Headless server. Users already have editors |
| Config location | `~/.codehands/config.json` | Central location, not tied to any project |
| Workspace handling | One shared exec-server, CodeHands validates paths | Lightweight: one process for all workspaces |
| Concurrency | One instance, multiple AI chats, multiple projects | No duplicate processes |
| Weight | Lightweight, low RAM, no bloat | Must run alongside 3-4 chats on 1-2 projects |
| Latency | Near-instant responses | Why local-first matters |
| UX | No UI. Headless server. Simple config. | Users already have editors |
| Error recovery | Auto-restart exec-server up to 3x, notify AIs | Graceful degradation |
| API key | None needed | exec-server is purely local |
| Distribution | GitHub clone + npm link | No publishing, global `codehands` command, simple updates via git pull |
| Startup | `codehands start` spawns exec-server automatically | Simple one-command |
| V1 scope | All exec-server tools + public hosted gateway | Full feature set from day one |

---

## 4. Why Codex CLI

Building file-system access, terminal execution, sandboxing, Git integration,
and safety from scratch is far too large a task for one person. Codex CLI
already provides all of it:

- Open-source (Apache 2.0), lightweight, Rust-based.
- Ranked first on Terminal-Bench (83.4%).
- exec-server provides exactly the granular operations we need.

---

## 5. Communication: exec-server

The exec-server is a lean Rust process that handles individual operations.
Our MCP tools mirror these operations with underscore naming (MCP spec
doesn't allow slashes in tool names).

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
| process_write | process/write | Send input to a running command |
| process_terminate | process/terminate | Kill a command |
| process_signal | process/signal | Send signal to process |
| http_request | http/request | Fetch a URL |
| workspace_list | (CodeHands) | List approved workspaces |
| workspace_set | (CodeHands) | Set active workspace for session |

16 tools total. CodeHands converts `_` back to `/` when forwarding to
exec-server.

---

## 6. Codex Performance Context

Known Codex CLI performance issues (memory leaks, orphaned processes) are in
the AGENT LOOP and MCP-spawning code — not in the exec-server. The exec-server
handles simple read/write/run operations without those problems.

---

## 7. Access Modes

- **Local (HTTP on localhost):** Primary mode. One CodeHands server handles
  multiple simultaneous AI chats. ~1-3ms latency.
- **Local (stdio adapter):** Thin wrapper for clients that only support stdio
  (e.g., Claude Desktop today). Connects to the HTTP core internally.
- **Hosted (tunnel-agnostic):** Server's HTTP port exposed via any tunnel
  (Tailscale Funnel, Cloudflare, ngrok). Default recommendation: Tailscale
  with Funnel (free, private, no domain needed). Auth required for hosted
  mode (v2).

Design is tunnel-agnostic: our server doesn't care what tunnel sits in front.

---

## 8. Security Model

- **Blocked commands list:** Rejects obviously dangerous operations (rm -rf /,
  format C:, etc.). Configurable.
- **Workspace validation:** Only approved folders (from config) can be accessed.
- **Codex exec-server sandbox:** Trusted for file system isolation and process
  sandboxing.
- **No max file size limit:** Trust exec-server to handle this.
- **Auth:** v2 (for hosted mode). Not needed for local stdio mode.
- **Rate limiting:** v2.

---

## 9. Target Providers

Both ChatGPT and Claude Chat are primary targets. Provider-specific connection
instructions will live in documentation, not in core logic.

---

## 10. Browser Capabilities

Browser automation (viewing pages, clicking elements, taking screenshots) may
be added later via an external Playwright plugin or Playwright MCP server.
Not in scope for the first version.
