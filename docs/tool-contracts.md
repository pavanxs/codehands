# MCP tool contracts

## Status

Implemented. Tools are atomic and provider-neutral. CodeHands validates and
forwards operations but does not run an autonomous loop.

## Tool list

| Tool | Purpose |
| --- | --- |
| `fs_readFile` | Read all or a line range |
| `fs_writeFile` | Create or overwrite a text file |
| `fs_replaceText` | Conflict-safe exact replacement |
| `fs_applyPatch` | Context-verified unified-diff hunks for one file |
| `fs_searchText` | Workspace text/regex search |
| `fs_createDirectory` | Create directories |
| `fs_readDirectory` | List a directory |
| `fs_walk` | Bounded tree walk without following directory symlinks |
| `fs_remove` | Remove a file or directory |
| `fs_copy` | Copy a file or directory |
| `fs_getMetadata` | Read file metadata |
| `process_start` | Start an executable with explicit argv |
| `process_read` | Read a session-owned process |
| `process_write` | Write to a session-owned process |
| `process_signal` | Interrupt a session-owned process |
| `process_terminate` | Terminate a session-owned process |
| `git_status` | Concise Git status |
| `git_diff` | Unstaged or staged Git diff |
| `http_request` | Policy-controlled outbound request, disabled by default |
| `workspace_list` | List configured roots |
| `workspace_set` | Select this session's active root |
| `activity_recent` | Recent sanitized calls and durations for this session |

## Invariants

- A relative path requires an active workspace.
- Absolute paths must remain in that active workspace after canonicalization.
- File and process RPCs always carry a sandbox context.
- `process_start.command` is one executable; arguments belong in `args`.
- Shell executables and environment overrides require explicit configuration.
- Process handles are not valid outside the MCP session that created them.
- HTTP requires an enabled policy, allowed method/host/protocol, and safe DNS
  result.
- Replace and patch tools verify expected content before writing.
- Tool failures are structured and included in sanitized activity records.
