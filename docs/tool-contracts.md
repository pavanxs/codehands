# MCP tool contracts

## Status: Decided

All exec-server operations are exposed as MCP tools using Codex's exact naming.
CodeHands is a passthrough — it validates, forwards, and returns.

## Tool list (16 tools)

MCP spec only allows `[A-Za-z0-9_-.]` in tool names (no slashes). We use
underscore as the namespace separator. CodeHands converts back to `/` for
exec-server JSON-RPC calls.

| MCP tool name | Category | What it does |
| --- | --- | --- |
| fs_readFile | File system | Read a file's contents |
| fs_writeFile | File system | Write/create a file |
| fs_createDirectory | File system | Create a directory |
| fs_readDirectory | File system | List directory contents |
| fs_walk | File system | Walk a directory tree recursively |
| fs_remove | File system | Delete a file or directory |
| fs_copy | File system | Copy a file |
| fs_getMetadata | File system | Get file info (size, modified, etc.) |
| process_start | Process | Run a terminal command |
| process_read | Process | Read output from a running command |
| process_write | Process | Send input to a running command |
| process_terminate | Process | Kill a running command |
| process_signal | Process | Send a signal to a process |
| http_request | HTTP | Fetch a URL from the executor machine |
| workspace_list | Workspace | List approved workspaces from config |
| workspace_set | Workspace | Set active workspace for this session |

## Tool call flow

1. Web AI calls an MCP tool (e.g., `fs_readFile` with path).
2. CodeHands resolves the full path (using active workspace for relative paths).
3. Policy engine checks: is the path within an approved workspace?
4. Policy engine checks: is this a blocked command? (process tools only)
5. Codex adapter converts tool name (`fs_readFile` → `fs/readFile`) and
   forwards the JSON-RPC call to exec-server.
6. Exec-server executes and returns the result.
7. CodeHands returns the result to the web AI.

## Constraints

- The web AI controls the agent loop. Tools are atomic operations, not
  autonomous tasks.
- Workspace validation: all paths must fall within approved workspaces.
- Blocked commands: dangerous commands are rejected before reaching exec-server.
- No max file size limit (trust exec-server).
- Auth required for hosted mode (v2).
- Rate limiting for hosted mode (v2).
