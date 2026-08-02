# Runtime tools and Codex workers

## Safer and faster commands

`process_start` now sends the command and each argument as a literal argument list. Shell symbols such as `|`, `;`, `$()` and parentheses are not interpreted. Paths with spaces therefore work without manual escaping.

Use `process_run` for finite commands. It starts the command, waits for completion, and returns a bounded stdout/stderr result in one MCP call. Keep `process_start`, `process_read`, `process_write`, and `process_terminate` for long-running or interactive processes.

Legacy callers that relied on implicit `/bin/sh -c` behaviour must migrate to `process_startShell`. Shell execution is disabled unless `allowShell` is true in `~/.codehands/config.json`. Shell mode is intentionally high risk: its script text can reference paths outside the approved workspace, so enable it only for trusted users and trusted scripts.

Direct command mode rejects an outside working directory, absolute paths outside the active workspace, and relative `..` paths that escape it. This is lexical command validation; the Codex executor remains responsible for the operating-system sandbox.

Process output is capped and includes truncation metadata. The process registry retains a bounded history, reconciles entries after executor restarts, and marks forgotten processes as `lost` instead of leaving them falsely `running`. `process_list` supports status filtering, pagination and compact output.

## Repository helpers

- `repo_snapshot`: compact branch, HEAD, status, remotes and package/test hints.
- `fs_search`: bounded text or path search with include/exclude filters.
- `fs_readRange`: line-numbered ranged reads.
- `fs_applyPatch`: unified-patch dry run or application.
- `test_run`: runs a named command from `testCommands`.
- `git_diff_summary`: compact changed-file and stat summary.

Example configuration:

```json
{
  "allowShell": false,
  "testCommands": {
    "unit": ["pnpm", "test"],
    "build": ["pnpm", "run", "build"]
  },
  "agentModels": ["gpt-5.6-sol"]
}
```

## Parallel Codex workers

The worker tools are a thin supervisor. ChatGPT or another MCP client still decides what work to delegate.

- `agent_start`: creates an isolated Git branch/worktree and starts one Codex `exec` worker.
- `agent_status`: reports compact lifecycle state.
- `agent_results`: returns bounded output plus a diff measured from the worker's starting commit.
- `agent_cancel`: terminates a worker and can explicitly remove its worktree and branch.
- `agent_run_many`: starts up to four independent workers in parallel.

Workers use non-interactive approval, an explicit `read-only` or `workspace-write` sandbox, and ephemeral Codex sessions. They are instructed not to commit, merge, push, deploy or delete branches. CodeHands never merges worker output automatically. Managed worktrees live under `.codehands/worktrees/`, which is ignored by Git.

Explicit models must be listed in `agentModels`. Normal tests mock the Codex adapter and do not make real model calls.
